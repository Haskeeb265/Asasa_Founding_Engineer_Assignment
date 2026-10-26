import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { prices } from "../db/schema";
import type { SettingsLike } from "./settings-like";
import { runQuorum, type Confidence, type QuorumSample, type SourceId } from "../../domain/quorum";
import { fetchPakGold } from "../sources/pakgold";
import { fetchGoldpriceOrg, isGoldpriceEnabled, GOLDPRICE_UNAVAILABLE_REASON } from "../sources/goldprice-org";
import { fetchYahooFutures } from "../sources/yahoo-futures";
import type { SourceResult } from "../sources/types";

export interface PriceSampleRow {
  source: SourceId;
  ok: boolean;
  pricePaisaPerGram: bigint | null;
  accepted: boolean;
  selected: boolean;
  reason: string | null;
}

export interface CycleResult {
  cycleId: string;
  fetchedAtSeconds: number;
  selectedSource: SourceId | null;
  selectedPrice: bigint | null;
  confidence: Confidence;
  degraded: boolean;
  /** Best usable provider market clock among accepted sources, epoch seconds. */
  providerSeconds: number | null;
  samples: PriceSampleRow[];
}

/** The trust anchor reminder: a source that moved by orders of magnitude is a unit error. */
const sanityOk = (anchor: bigint | null, price: bigint): boolean => {
  if (anchor === null || anchor <= 0n) return true;
  return price >= anchor / 10n && price <= anchor * 10n;
};

async function lastTrustedPrice(): Promise<bigint | null> {
  // The anchor is the last *selected* price we ever published, not the latest raw print.
  const rows = await db
    .select({ price: prices.pricePaisaPerGram })
    .from(prices)
    .where(eq(prices.selected, true))
    .orderBy(prices.fetchedAt)
    .limit(50);
  const usable = rows.filter((r) => r.price !== null);
  const row = usable[usable.length - 1];
  return row?.price ?? null;
}

/**
 * One cycle = one attempt per enabled source (never retries within a cycle),
 * the quorum verdict, and one `prices` row per source so the UI can explain
 * every acceptance and rejection (§6.4's explainability panel).
 */
export async function runPricingCycle(settings: SettingsLike): Promise<CycleResult> {
  const cycleId = randomUUID();
  const fetchedAtSeconds = Math.floor(Date.now() / 1000);
  const anchor = await lastTrustedPrice();

  const plan: Array<{ source: SourceId; attempt: Promise<SourceResult> }> = [];
  if (settings.sourceAOn) {
    plan.push({ source: "A_pakgold", attempt: fetchPakGold() });
  }
  if (settings.sourceBOn) {
    // §6.2: B only when the host can impersonate a browser TLS handshake;
    // elsewhere it is a documented gap with its own row, not a silent skip.
    plan.push({
      source: "B_goldprice",
      attempt: isGoldpriceEnabled()
        ? fetchGoldpriceOrg()
        : Promise.resolve({ ok: false as const, reason: GOLDPRICE_UNAVAILABLE_REASON }),
    });
  }
  if (settings.sourceCOn) {
    plan.push({ source: "C_yahoo", attempt: fetchYahooFutures(settings.sourceCBasisBps) });
  }

  const settled = await Promise.allSettled(plan.map((p) => p.attempt));

  const proofs = plan.map((p, i) => {
    const outcome = settled[i];
    return {
      source: p.source,
      ok: outcome?.status === "fulfilled" && outcome.value.ok,
      quote: outcome?.status === "fulfilled" && outcome.value.ok ? outcome.value.quote : null,
      reason: outcome?.status === "fulfilled" && !outcome.value.ok
        ? outcome.value.reason
        : outcome?.status === "rejected"
          ? String(outcome.reason)
          : null,
    } as {
      source: SourceId;
      ok: boolean;
      quote: null | (SourceResult & { ok: true })["quote"];
      reason: string | null;
    };
  });

  const samples: PriceSampleRow[] = [];

  const quorumInputs: QuorumSample[] = [];
  for (const proof of proofs) {
    if (
      proof.ok &&
      proof.quote !== null &&
      sanityOk(anchor, proof.quote.paisaPerGram)
    ) {
      quorumInputs.push({ source: proof.source, pricePaisaPerGram: proof.quote.paisaPerGram });
    }
  }

  const quorum = runQuorum(quorumInputs, settings.divergenceThresholdBps, anchor);

  const providerSeconds = quorum.accepted.reduce<number | null>((max, sample) => {
    const seconds = proofs.find((p) => p.source === sample.source)?.quote?.providerSeconds ?? null;
    if (seconds === null) return max;
    return max === null ? seconds : Math.max(max, seconds);
  }, null);

  for (const proof of proofs) {
    const accepted = quorum.accepted.some((s) => s.source === proof.source);
    const selected = quorum.selectedSource === proof.source;
    const rejection = quorum.rejected.find((r) => r.source === proof.source);
    const reason = !proof.ok
      ? proof.reason
      : selected
        ? null
        : (rejection?.reason ?? "accepted, but a higher-priority source was published");

    samples.push({
      source: proof.source,
      ok: proof.ok,
      pricePaisaPerGram: proof.quote?.paisaPerGram ?? null,
      accepted,
      selected,
      reason,
    });
  }

  await db.insert(prices).values(
    samples.map((s) => ({
      cycleId,
      fetchedAt: new Date(fetchedAtSeconds * 1000),
      source: s.source,
      pricePaisaPerGram: s.pricePaisaPerGram,
      accepted: s.accepted,
      selected: s.selected,
      reason: s.reason,
    })),
  );

  return {
    cycleId,
    fetchedAtSeconds,
    selectedSource: quorum.selectedSource,
    selectedPrice: quorum.selectedPrice,
    confidence: quorum.confidence,
    degraded: quorum.degraded,
    providerSeconds,
    samples,
  };
}
