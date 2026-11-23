/**
 * Pure price quorum. Decides which samples are trusted and which one is
 * published. The published price is always one named source's number.
 */

export type SourceId = 'A_pakgold' | 'B_goldprice' | 'C_yahoo';

export const SOURCE_PRIORITY: SourceId[] = ['A_pakgold', 'B_goldprice', 'C_yahoo'];

export type QuorumStatus = 'paused' | 'single_source' | 'validated' | 'degraded';

export interface QuorumSample {
  source: SourceId;
  paisaPerGram: bigint;
}

export interface Decision {
  accepted: boolean;
  reason: string;
}

export interface QuorumResult {
  decisions: Record<SourceId, Decision>;
  selected: SourceId | null;
  status: QuorumStatus;
}

/** Symmetric divergence in basis points: |a-b| × 20000 / (a+b), floored. */
export function divergenceBps(a: bigint, b: bigint): number {
  if (a <= 0n || b <= 0n) throw new RangeError('prices must be positive');
  return Number((absBigInt(a - b) * 20_000n) / (a + b));
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function priorityIndex(source: SourceId): number {
  return SOURCE_PRIORITY.indexOf(source);
}

function byPriority(a: QuorumSample, b: QuorumSample): number {
  return priorityIndex(a.source) - priorityIndex(b.source);
}

function defaultDecisions(): Record<SourceId, Decision> {
  return {
    A_pakgold: { accepted: false, reason: 'not attempted' },
    B_goldprice: { accepted: false, reason: 'not attempted' },
    C_yahoo: { accepted: false, reason: 'not attempted' },
  };
}

/**
 * @param samples      samples that answered (failed sources are not included)
 * @param thresholdBps maximum tolerated pairwise/median divergence
 * @param anchor       most recent trusted published price, or null
 */
export function evaluate(
  samples: QuorumSample[],
  thresholdBps: number,
  anchor: bigint | null,
): QuorumResult {
  const decisions = defaultDecisions();

  // One row per source; keep the first if a caller accidentally duplicates.
  const unique = new Map<SourceId, QuorumSample>();
  for (const sample of samples) {
    if (!unique.has(sample.source)) unique.set(sample.source, sample);
  }
  let candidates = [...unique.values()].sort(byPriority);

  // Sanity gate: unit errors are dropped before counting.
  if (anchor !== null && anchor > 0n) {
    const low = anchor / 10n;
    const high = anchor * 10n;
    candidates = candidates.filter((sample) => {
      if (sample.paisaPerGram < low || sample.paisaPerGram > high) {
        decisions[sample.source] = {
          accepted: false,
          reason: 'outside 10× of last trusted price',
        };
        return false;
      }
      return true;
    });
  }

  const n = candidates.length;

  if (n === 0) {
    return { decisions, selected: null, status: 'paused' };
  }

  if (n === 1) {
    const only = candidates[0];
    decisions[only.source] = {
      accepted: true,
      reason: 'only source that answered',
    };
    return { decisions, selected: only.source, status: 'single_source' };
  }

  if (n === 2) {
    const [first, second] = candidates;
    const bps = divergenceBps(first.paisaPerGram, second.paisaPerGram);
    if (bps <= thresholdBps) {
      decisions[first.source] = {
        accepted: true,
        reason: `within ${bps} bps of ${second.source}`,
      };
      decisions[second.source] = {
        accepted: true,
        reason: `within ${bps} bps of ${first.source}`,
      };
      return {
        decisions,
        selected: first.source,
        status: 'validated',
      };
    }

    if (anchor !== null) {
      const firstDistance = absBigInt(first.paisaPerGram - anchor);
      const secondDistance = absBigInt(second.paisaPerGram - anchor);
      // Tie goes against the lower priority source (first wins on a tie).
      const rejected =
        secondDistance < firstDistance ? first : second;
      const accepted = rejected === first ? second : first;
      decisions[accepted.source] = {
        accepted: true,
        reason: `diverges ${bps} bps from ${rejected.source}; closer to anchor`,
      };
      decisions[rejected.source] = {
        accepted: false,
        reason: `diverges ${bps} bps from ${accepted.source}; further from anchor`,
      };
      return { decisions, selected: accepted.source, status: 'validated' };
    }

    // No anchor: publish by priority, accept only the published sample.
    decisions[first.source] = {
      accepted: true,
      reason: 'diverges, no anchor to arbitrate; higher priority',
    };
    decisions[second.source] = {
      accepted: false,
      reason: `diverges, no anchor to arbitrate (${bps} bps from ${first.source})`,
    };
    return { decisions, selected: first.source, status: 'degraded' };
  }

  // n >= 3: median arbitrates. For the three-source demo this is exactly 3.
  const sorted = [...candidates].sort((a, b) =>
    a.paisaPerGram < b.paisaPerGram ? -1 : a.paisaPerGram > b.paisaPerGram ? 1 : 0,
  );
  const median = sorted[Math.floor(sorted.length / 2)].paisaPerGram;

  const accepted: QuorumSample[] = [];
  for (const sample of candidates) {
    const bps = divergenceBps(sample.paisaPerGram, median);
    if (bps <= thresholdBps) {
      accepted.push(sample);
      decisions[sample.source] = {
        accepted: true,
        reason:
          sample.paisaPerGram === median
            ? 'median'
            : `within ${bps} bps of median`,
      };
    } else {
      decisions[sample.source] = {
        accepted: false,
        reason: `outlier: ${bps} bps from median`,
      };
    }
  }

  if (accepted.length === 0) {
    // Unreachable: the median is itself a sample. Guard anyway.
    return { decisions, selected: null, status: 'paused' };
  }

  const selected = accepted.sort(byPriority)[0].source;
  return { decisions, selected, status: 'validated' };
}
