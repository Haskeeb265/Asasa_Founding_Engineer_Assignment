/**
 * Divergence validation and price selection (flow.md §3.4–§3.7), pure.
 *
 * After each fetch cycle, ALL pairwise divergences are computed on the
 * full-precision normalized prices; a pair is consistent when its divergence
 * is below 0.5%. A displayed price must be validated against at least one
 * other OK source — at least two OK sources must agree — so there is never
 * an unvalidated, single-source or last-known price. Yahoo (C) validates
 * only; it is never the displayed source.
 */
import Big from "big.js";

export type SourceId = "A_pakgold" | "B_goldprice" | "C_yahoo";
export type SourceStatus = "OK" | "FAILED" | "INVALID" | "STALE" | "UNRELIABLE";
export type PriceState = "VALID" | "NO_PRICE";

/** Source roles (§3.1). A primary, B secondary; C never displayed. */
export const PRIMARY_SOURCE: SourceId = "A_pakgold";
export const SECONDARY_SOURCE: SourceId = "B_goldprice";

/** Threshold: a pair is consistent when its divergence is below 0.5%. */
export const DIVERGENCE_THRESHOLD_PERCENT = new Big("0.5");

/** Display names used in the UI notice (§3.6). */
export const SOURCE_DISPLAY: Record<SourceId, string> = {
  A_pakgold: "PakGold.pk",
  B_goldprice: "Goldprice.org",
  C_yahoo: "Yahoo",
};

export type PairKey = "a_b" | "b_c" | "a_c";

export interface RawSourceResult {
  source: SourceId;
  status: SourceStatus;
  /** Full-precision normalized price (PKR per gram, 24K), null when not OK. */
  pricePkrPerGram: Big | null;
  errorReason: string | null;
}

export interface PairValue {
  key: PairKey;
  /** Full-precision divergence in percent; null when NOT_COMPUTED. */
  divergencePercent: Big | null;
  consistent: boolean;
}

export interface ValidationOutcome {
  /** Per-source final statuses after outlier flagging. */
  statuses: Array<{ source: SourceId; status: SourceStatus; errorReason: string | null }>;
  /** a_b, b_c, a_c — null means NOT_COMPUTED (a pair involving an excluded source). */
  divergences: PairValue[];
  selectedSource: SourceId | null;
  selectedPrice: Big | null;
  state: PriceState;
  /** False when the displayed source is not PakGold.pk (fallback notice, §3.6). */
  isFallback: boolean;
  notice: string | null;
}

/**
 * Divergence on the full-precision normalized prices:
 *   abs(x - y) / ((x + y) / 2) * 100  — percent, never rounded.
 */
export function divergencePercent(x: Big, y: Big): Big {
  if (!x.gt(0) || !y.gt(0)) {
    throw new RangeError("divergence is defined only for positive prices");
  }
  const diff = x.gt(y) ? x.minus(y) : y.minus(x);
  return diff.div(x.plus(y).div(2)).times(100);
}

const consistent = (d: Big): boolean => d.lt(DIVERGENCE_THRESHOLD_PERCENT);

/**
 * The whole §3.4–§3.6 pipeline for one cycle.
 *
 * Inputs carry the post-fetch status per source: OK means fetched, parsed and
 * sane; FAILED/INVALID/STALE anything else (status/error reason already set).
 * A source that is not OK is excluded; every pair involving it becomes
 * NOT_COMPUTED. The outlier (a fetched source that disagrees with both others)
 * is re-flagged UNRELIABLE and excluded.
 */
export function validatePrices(inputs: RawSourceResult[]): ValidationOutcome {
  if (inputs.length !== 3) {
    throw new Error("validatePrices expects exactly the three sources A, B, C");
  }
  const bySource = new Map<SourceId, RawSourceResult>();
  for (const input of inputs) bySource.set(input.source, input);

  const a = bySource.get("A_pakgold");
  const b = bySource.get("B_goldprice");
  const c = bySource.get("C_yahoo");
  if (!a || !b || !c) throw new Error("validatePrices missing a source");

  const pairs: Array<{ key: PairKey; first: RawSourceResult; second: RawSourceResult; d: Big | null }> = [
    { key: "a_b", first: a, second: b, d: pairDivergence(a, b) },
    { key: "b_c", first: b, second: c, d: pairDivergence(b, c) },
    { key: "a_c", first: a, second: c, d: pairDivergence(a, c) },
  ];
  // No status changes from NOT_COMPUTED: a fetched-OK source whose validator
  // partners died keeps its OK status — it simply has no computable pair, so
  // it cannot be selected (§3.5 requires a consistent partner).

  // Outlier identification on the fetched sources that are still OK:
  // ok/ok/ok -> reliable; one source disagreeing with BOTH other sources
  // (whose mutual pair is ok) is the outlier and becomes UNRELIABLE;
  // every pair bad -> no trustworthy source.
  const fetched = [a, b, c].filter((s) => s.status === "OK");
  if (fetched.length === 3) {
    const { a_b, b_c, a_c } = computedMap(pairs);
    if (a_b !== null && a_c !== null && b_c !== null) {
      const aOutlier = !consistent(a_b) && !consistent(a_c) && consistent(b_c);
      const bOutlier = !consistent(a_b) && !consistent(b_c) && consistent(a_c);
      const cOutlier = !consistent(a_c) && !consistent(b_c) && consistent(a_b);
      if (aOutlier) { a.status = "UNRELIABLE"; a.errorReason = "outlier: diverges from both B and C"; }
      if (bOutlier) { b.status = "UNRELIABLE"; b.errorReason = "outlier: diverges from both A and C"; }
      if (cOutlier) { c.status = "UNRELIABLE"; c.errorReason = "outlier: diverges from both A and B"; }
      // All three pairs bad: no trustworthy source; treat as price unavailable.
      if (!consistent(a_b) && !consistent(b_c) && !consistent(a_c)) {
        if (a.status === "OK") { a.status = "UNRELIABLE"; a.errorReason = "all divergence pairs failed"; }
        if (b.status === "OK") { b.status = "UNRELIABLE"; b.errorReason = "all divergence pairs failed"; }
        if (c.status === "OK") { c.status = "UNRELIABLE"; c.errorReason = "all divergence pairs failed"; }
      }
    }
  } else if (fetched.length === 2) {
    // Only one pair is computable; if it is bad, both fetched sources are
    // excluded for this cycle (§3.7: not-excluded pairs only).
    const computable = pairs.find((p) => p.d !== null);
    const computableD = computable?.d ?? null;
    if (computable && computableD !== null && !consistent(computableD)) {
      const otherLabel = SOURCE_DISPLAY[computable.second.source];
      if (computable.first.status === "OK") {
        computable.first.status = "UNRELIABLE";
        computable.first.errorReason = `divergence vs ${otherLabel} is ${computableD.toFixed(4)}%`;
      }
      if (computable.second.status === "OK") {
        computable.second.status = "UNRELIABLE";
        computable.second.errorReason = `divergence vs ${SOURCE_DISPLAY[computable.first.source]} is ${computableD.toFixed(4)}%`;
      }
    }
  }

  const divergences: PairValue[] = pairs.map((p) => ({
    key: p.key,
    divergencePercent: p.d,
    consistent: p.d === null ? false : consistent(p.d),
  }));

  // §3.5 — strict selection, updated after any downgrade above: A when OK and
  // consistent with at least one other OK source; else B under the same rule;
  // otherwise no price (§3.7 no-price rule).
  const { a_b, b_c, a_c } = consistentMap(divergences);
  const aConsistent = a.status === "OK" && (a_b || a_c);
  const bConsistent = b.status === "OK" && (a_b || b_c);

  const selectedSource = aConsistent ? "A_pakgold" : bConsistent ? "B_goldprice" : null;
  const selectedPrice = selectedSource === null ? null : (bySource.get(selectedSource)?.pricePkrPerGram ?? null);

  const isFallback = selectedSource !== null && selectedSource !== PRIMARY_SOURCE;
  const notice = selectedSource === null
    ? null
    : isFallback
      ? `Fallback source: ${SOURCE_DISPLAY[selectedSource]}, ${SOURCE_DISPLAY[PRIMARY_SOURCE]} unavailable`
      : null;

  return {
    statuses: [a, b, c].map((s) => ({ source: s.source, status: s.status, errorReason: s.errorReason })),
    divergences,
    selectedSource,
    selectedPrice,
    state: selectedSource === null ? "NO_PRICE" : "VALID",
    isFallback,
    notice,
  };
}

/** NOT_COMPUTED wording for the UI when a pair has no value. */
export function pairLabel(pair: PairValue): string {
  if (pair.divergencePercent === null) return "NOT_COMPUTED";
  return `${pair.divergencePercent.toFixed(4).replace(/\.?0+$/, "")}% ${pair.consistent ? "ok" : "bad"}`;
}

function pairDivergence(x: RawSourceResult, y: RawSourceResult): Big | null {
  if (x.status !== "OK" || y.status !== "OK") return null; // NOT_COMPUTED
  if (x.pricePkrPerGram === null || y.pricePkrPerGram === null) return null;
  return divergencePercent(x.pricePkrPerGram, y.pricePkrPerGram);
}


function consistentMap(pairs: PairValue[]): { a_b: boolean; b_c: boolean; a_c: boolean } {
  const by = (key: PairKey) => pairs.find((p) => p.key === key)?.consistent ?? false;
  return { a_b: by("a_b"), b_c: by("b_c"), a_c: by("a_c") };
}

function computedMap(pairs: Array<{ key: PairKey; d: Big | null }>): Record<PairKey, Big | null> {
  return Object.fromEntries(pairs.map((p) => [p.key, p.d])) as Record<PairKey, Big | null>;
}
