import { describe, expect, it } from 'vitest';
import {
  AmountError,
  GRAMS_PER_TROY_OZ,
  MAX_NOTIONAL_PAISA,
  MIN_GOLD_UG,
  MIN_PKR_PAISA,
  formatGrams,
  formatPkr,
  formatPricePerGram,
  ingestPkrPerTroyOz,
  ingestUsdPerTroyOz,
  parseGrams,
  parsePkr,
  toWire,
} from '../../domain/units';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AmountError) return error.code;
    throw error;
  }
  throw new Error('expected an AmountError');
}

describe('parsePkr', () => {
  it('accepts whole numbers', () => {
    expect(parsePkr('1')).toBe(100n);
    expect(parsePkr('1000')).toBe(100_000n);
  });

  it('accepts two decimal places', () => {
    expect(parsePkr('1.5')).toBe(150n);
    expect(parsePkr('1000.00')).toBe(100_000n);
    expect(parsePkr('12345.67')).toBe(1_234_567n);
  });

  it('rejects empty, whitespace, text and non-decimal forms', () => {
    for (const value of ['', '   ', 'abc', 'NaN', 'Infinity', '1e3', '+5', '1,000', '1.2.3', '.5']) {
      expect(codeOf(() => parsePkr(value)), value).toBe('INVALID_AMOUNT');
    }
  });

  it('rejects zero and negatives as non-positive', () => {
    for (const value of ['0', '0.00', '-0', '-5', '-0.01']) {
      expect(codeOf(() => parsePkr(value)), value).toBe('AMOUNT_NOT_POSITIVE');
    }
  });

  it('rejects more than two decimals for PKR', () => {
    expect(codeOf(() => parsePkr('1.234'))).toBe('TOO_MANY_DECIMALS');
  });

  it('rejects JSON numbers, not just numeric strings', () => {
    expect(codeOf(() => parsePkr(1000))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => parsePkr(null))).toBe('INVALID_AMOUNT');
  });
});

describe('parseGrams', () => {
  it('accepts up to six decimals', () => {
    expect(parseGrams('0.1')).toBe(100_000n);
    expect(parseGrams('0.000001')).toBe(1n);
    expect(parseGrams('20')).toBe(20_000_000n);
    expect(parseGrams('1.278241')).toBe(1_278_241n);
  });

  it('rejects more than six decimals', () => {
    expect(codeOf(() => parseGrams('0.1234567'))).toBe('TOO_MANY_DECIMALS');
  });
});

describe('constants', () => {
  it('uses the documented boundaries', () => {
    expect(MIN_PKR_PAISA).toBe(100_000n);
    expect(MIN_GOLD_UG).toBe(100_000n);
    expect(MAX_NOTIONAL_PAISA).toBe(100_000_000n);
    expect(GRAMS_PER_TROY_OZ).toBeCloseTo(31.1034768, 7);
  });
});

describe('ingestion rounding', () => {
  it('converts USD/oz × USD/PKR for source A and C', () => {
    expect(ingestUsdPerTroyOz(4000, 279.5)).toBe(3_594_453n);
    expect(ingestUsdPerTroyOz(4000, 278)).toBe(3_575_163n);
    expect(ingestUsdPerTroyOz(3000, 279.5)).toBe(2_695_840n);
  });

  it('converts PKR/oz for source B', () => {
    expect(ingestPkrPerTroyOz(1_106_047)).toBe(3_556_024n);
  });

  it('rejects non-finite and non-positive inputs', () => {
    expect(() => ingestUsdPerTroyOz(Number.NaN, 279.5)).toThrow(RangeError);
    expect(() => ingestUsdPerTroyOz(4000, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => ingestUsdPerTroyOz(0, 279.5)).toThrow(RangeError);
    expect(() => ingestPkrPerTroyOz(-1)).toThrow(RangeError);
  });
});

describe('formatters', () => {
  it('formats PKR with grouping and two decimals', () => {
    expect(formatPkr(5_000_000n)).toBe('Rs 50,000.00');
    expect(formatPkr(1_234_567n)).toBe('Rs 12,345.67');
    expect(formatPkr(1n)).toBe('Rs 0.01');
    expect(formatPkr(-150n)).toBe('-Rs 1.50');
  });

  it('formats grams with up to six decimals', () => {
    expect(formatGrams(1_278_241n)).toBe('1.278241 g');
    expect(formatGrams(20_000_000n)).toBe('20 g');
    expect(formatGrams(100_000n)).toBe('0.1 g');
  });

  it('formats prices per gram', () => {
    expect(formatPricePerGram(3_911_626n)).toBe('Rs 39,116.26/g');
  });
});

describe('wire safety', () => {
  it('never lets a bigint or Date survive serialisation', () => {
    const wire = toWire({
      amount: 123n,
      at: new Date('2026-11-24T10:00:00.000Z'),
      nested: [{ grams: 20_000_000n }],
      keep: 'text',
    }) as Record<string, unknown>;

    expect(wire.amount).toBe('123');
    expect(wire.at).toBe('2026-11-24T10:00:00.000Z');
    expect((wire.nested as Array<Record<string, unknown>>)[0].grams).toBe('20000000');
    expect(typeof wire.keep).toBe('string');

    const json = JSON.stringify(wire);
    expect(json).not.toContain('123n');
    expect(JSON.parse(json).amount).toBe('123');
  });
});
