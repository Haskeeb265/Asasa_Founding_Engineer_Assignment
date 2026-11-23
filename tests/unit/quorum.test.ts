import { describe, expect, it } from 'vitest';
import {
  divergenceBps,
  evaluate,
  type QuorumSample,
  type SourceId,
} from '../../domain/quorum';

const A: QuorumSample = { source: 'A_pakgold', paisaPerGram: 4_000_000n };
const B: QuorumSample = { source: 'B_goldprice', paisaPerGram: 4_010_000n };
const C: QuorumSample = { source: 'C_yahoo', paisaPerGram: 4_020_000n };

function sample(source: SourceId, price: bigint): QuorumSample {
  return { source, paisaPerGram: price };
}

describe('divergenceBps', () => {
  it('is symmetric and floored', () => {
    const forward = divergenceBps(4_000_000n, 4_040_000n);
    const backward = divergenceBps(4_040_000n, 4_000_000n);
    expect(forward).toBe(99);
    expect(backward).toBe(99);
    expect(divergenceBps(A.paisaPerGram, A.paisaPerGram)).toBe(0);
  });

  it('rejects non-positive prices', () => {
    expect(() => divergenceBps(0n, 4_000_000n)).toThrow(RangeError);
  });
});

describe('n = 0', () => {
  it('pauses and publishes nothing', () => {
    const result = evaluate([], 100, null);
    expect(result.status).toBe('paused');
    expect(result.selected).toBeNull();
  });
});

describe('n = 1', () => {
  it('accepts a lone source without deadlocking, including PakGold', () => {
    const result = evaluate([A], 100, null);
    expect(result.selected).toBe('A_pakgold');
    expect(result.status).toBe('single_source');
    expect(result.decisions.A_pakgold).toEqual({
      accepted: true,
      reason: 'only source that answered',
    });
  });
});

describe('n = 2', () => {
  it('accepts both within the threshold and publishes by priority', () => {
    const result = evaluate([B, A], 100, null);
    expect(result.status).toBe('validated');
    expect(result.selected).toBe('A_pakgold');
    expect(result.decisions.A_pakgold.accepted).toBe(true);
    expect(result.decisions.B_goldprice.accepted).toBe(true);
  });

  it('rejects the sample further from the anchor', () => {
    const result = evaluate(
      [A, sample('C_yahoo', 4_200_000n)],
      100,
      4_000_000n,
    );
    expect(result.status).toBe('validated');
    expect(result.selected).toBe('A_pakgold');
    expect(result.decisions.A_pakgold.accepted).toBe(true);
    expect(result.decisions.C_yahoo.accepted).toBe(false);
    expect(result.decisions.C_yahoo.reason).toContain('anchor');
  });

  it('rejects the lower priority source on an anchor tie', () => {
    const result = evaluate(
      [sample('A_pakgold', 4_000_000n), sample('C_yahoo', 4_200_000n)],
      100,
      4_100_000n,
    );
    expect(result.selected).toBe('A_pakgold');
    expect(result.decisions.A_pakgold.accepted).toBe(true);
    expect(result.decisions.C_yahoo.accepted).toBe(false);
  });

  it('publishes by priority and marks degraded when there is no anchor', () => {
    const result = evaluate(
      [sample('A_pakgold', 4_000_000n), sample('C_yahoo', 4_200_000n)],
      100,
      null,
    );
    expect(result.status).toBe('degraded');
    expect(result.selected).toBe('A_pakgold');
    expect(result.decisions.A_pakgold.accepted).toBe(true);
    expect(result.decisions.C_yahoo.accepted).toBe(false);
    expect(result.decisions.C_yahoo.reason).toContain('no anchor');
  });
});

describe('n = 3', () => {
  it('accepts all samples around the median and publishes the highest priority', () => {
    const result = evaluate([C, A, B], 100, null);
    expect(result.status).toBe('validated');
    expect(result.selected).toBe('A_pakgold');
    expect(Object.values(result.decisions).every((d) => d.accepted)).toBe(true);
  });

  it('rejects an outlier from the median', () => {
    const result = evaluate(
      [A, B, sample('C_yahoo', 4_400_000n)],
      100,
      null,
    );
    expect(result.selected).toBe('A_pakgold');
    expect(result.decisions.C_yahoo.accepted).toBe(false);
    expect(result.decisions.C_yahoo.reason).toContain('outlier');
    expect(result.decisions.A_pakgold.accepted).toBe(true);
    expect(result.decisions.B_goldprice.accepted).toBe(true);
  });

  it('tightening the threshold rejects previously accepted samples', () => {
    const loose = evaluate([A, B, C], 100, null);
    expect(Object.values(loose.decisions).filter((d) => d.accepted)).toHaveLength(3);

    const tight = evaluate([A, B, C], 1, null);
    expect(tight.selected).toBe('B_goldprice');
    expect(tight.decisions.B_goldprice.accepted).toBe(true);
    expect(tight.decisions.A_pakgold.accepted).toBe(false);
    expect(tight.decisions.C_yahoo.accepted).toBe(false);
  });
});

describe('sanity gate', () => {
  it('drops a unit error before counting', () => {
    const result = evaluate(
      [A, sample('B_goldprice', 50_000_000n)],
      100,
      4_000_000n,
    );
    expect(result.status).toBe('single_source');
    expect(result.decisions.B_goldprice.accepted).toBe(false);
    expect(result.decisions.B_goldprice.reason).toContain('outside 10×');
  });

  it('drops a too-small unit error too', () => {
    const result = evaluate(
      [A, sample('C_yahoo', 100_000n)],
      100,
      4_000_000n,
    );
    expect(result.decisions.C_yahoo.reason).toContain('outside 10×');
    expect(result.status).toBe('single_source');
  });
});

describe('priority and reasons', () => {
  it('selects A over B over C when all are accepted', () => {
    expect(evaluate([C, B, A], 5000, null).selected).toBe('A_pakgold');
    expect(
      evaluate([C, sample('B_goldprice', 4_000_001n)], 5000, null).selected,
    ).toBe('B_goldprice');
    expect(evaluate([C], 100, null).selected).toBe('C_yahoo');
  });

  it('gives every evaluated sample an explainable reason', () => {
    const result = evaluate([A, B, C], 100, null);
    for (const decision of Object.values(result.decisions)) {
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});
