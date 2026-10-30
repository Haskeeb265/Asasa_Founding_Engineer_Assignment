/**
 * The quorum rule (§6.4), pure and integer-only.
 *
 * The published price is always ONE source's number — never an average —
 * so "source" in the UI stays truthful. Selection prefers
 * A (PakGold) > B (GoldPrice.org) > C (Yahoo GC=F).
 */
export type SourceId = "A_pakgold" | "B_goldprice" | "C_yahoo";

/** Priority order: the first source that survives the quorum is the one we publish. */
export const SOURCE_PRIORITY: readonly SourceId[] = ["A_pakgold", "B_goldprice", "C_yahoo"] as const;

export const priorityOf = (source: SourceId): number => SOURCE_PRIORITY.indexOf(source);

export interface QuorumSample {
  source: SourceId;
  /** Already sanitized (numeric, > 0, within 10x of last trusted) by the caller. */
  pricePaisaPerGram: bigint;
}

export type Confidence = "validated" | "single_source" | "paused";

export interface QuorumOutcome {
  selectedSource: SourceId | null; // null => paused, no quotes
  selectedPrice: bigint | null;
  confidence: Confidence;
  degraded: boolean;
  accepted: QuorumSample[];
  rejected: Array<{ source: SourceId; pricePaisaPerGram: bigint; reason: string }>;
}

/**
 * |a-b| x 20000 / (a+b), integer throughout — symmetric percentage distance
 * that can never divide by zero for positive prices.
 */
export function divergenceBps(a: bigint, b: bigint): number {
  if (a <= 0n || b <= 0n) {
    throw new RangeError("divergence is defined only for positive prices");
  }
  const diff = a > b ? a - b : b - a;
  return Number((diff * 20000n) / (a + b));
}

/** Odd n -> the middle; even n -> the lower middle (integer-safe, still a member). */
export function median(prices: bigint[]): bigint {
  const sorted = [...prices].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const mid = Math.floor((sorted.length - 1) / 2);
  const value = sorted[mid];
  if (value === undefined) throw new RangeError("median of an empty list");
  return value;
}

/**
 * The quorum table from §6.4:
 *   n=0  paused
 *   n=1  accept it (single_source) — a validator must never deadlock the demo
 *   n=2  agree -> both, pick priority; disagree -> whoever is further from the
 *        last trusted price loses; with no anchor, priority wins and we degrade
 *   n>=3 accept everything within T of the median, reject the rest
 */
export function runQuorum(
  samples: QuorumSample[],
  thresholdBps: number,
  lastTrustedPaisaPerGram: bigint | null,
): QuorumOutcome {
  if (samples.length === 0) {
    return {
      selectedSource: null,
      selectedPrice: null,
      confidence: "paused",
      degraded: true,
      accepted: [],
      rejected: [],
    };
  }

  // Work on a priority-ordered copy so "first accepted" is always the publishable one.
  const ordered = [...samples].sort((a, b) => priorityOf(a.source) - priorityOf(b.source));

  if (samples.length === 1) {
    const only = ordered[0];
    if (only === undefined) throw new Error("unreachable");
    return {
      selectedSource: only.source,
      selectedPrice: only.pricePaisaPerGram,
      confidence: "single_source",
      degraded: only.source !== "A_pakgold",
      accepted: [only],
      rejected: [],
    };
  }

  if (samples.length === 2) {
    const first = ordered[0];
    const second = ordered[1];
    if (first === undefined || second === undefined) throw new Error("unreachable");

    const d = divergenceBps(first.pricePaisaPerGram, second.pricePaisaPerGram);
    if (d <= thresholdBps) {
      return {
        selectedSource: first.source,
        selectedPrice: first.pricePaisaPerGram,
        confidence: "validated",
        degraded: first.source !== "A_pakgold",
        accepted: [first, second],
        rejected: [],
      };
    }

    // Disagreement: the last trusted price is the tie-breaker — it is the only
    // prior belief in the system that is not derived from the two arguing sources.
    if (lastTrustedPaisaPerGram !== null && lastTrustedPaisaPerGram > 0n) {
      const dFirst = divergenceBps(first.pricePaisaPerGram, lastTrustedPaisaPerGram);
      const dSecond = divergenceBps(second.pricePaisaPerGram, lastTrustedPaisaPerGram);
      const [loser, winner] = dFirst >= dSecond ? [first, second] : [second, first];
      return {
        selectedSource: winner.source,
        selectedPrice: winner.pricePaisaPerGram,
        confidence: "validated",
        degraded: winner.source !== "A_pakgold",
        accepted: [winner],
        rejected: [{ source: loser.source, pricePaisaPerGram: loser.pricePaisaPerGram, reason: "divergence" }],
      };
    }

    // No anchor: trust priority, flag the other loudly.
    return {
      selectedSource: first.source,
      selectedPrice: first.pricePaisaPerGram,
      confidence: "single_source",
      degraded: true,
      accepted: [first],
      rejected: [{ source: second.source, pricePaisaPerGram: second.pricePaisaPerGram, reason: "divergence (no trusted anchor)" }],
    };
  }

  // n >= 3: median outlier rejection. The median of odd n is itself one of the
  // sources, so it always accepts itself — this branch cannot deadlock.
  const prices = ordered.map((s) => s.pricePaisaPerGram);
  const m = median([...prices]);

  const accepted: QuorumSample[] = [];
  const rejected: QuorumOutcome["rejected"] = [];
  for (const sample of ordered) {
    if (divergenceBps(sample.pricePaisaPerGram, m) <= thresholdBps) {
      accepted.push(sample);
    } else {
      rejected.push({ source: sample.source, pricePaisaPerGram: sample.pricePaisaPerGram, reason: "divergence" });
    }
  }

  const winner = accepted[0];
  if (winner === undefined) throw new Error("unreachable: median always accepts itself");

  return {
    selectedSource: winner.source,
    selectedPrice: winner.pricePaisaPerGram,
    confidence: "validated",
    degraded: winner.source !== "A_pakgold",
    accepted,
    rejected,
  };
}
