import { describe, expect, it } from 'vitest';
import {
  BUY_SPREAD_BPS,
  SELL_SPREAD_BPS,
  ceilDiv,
  checkLimits,
  computeBuyFromGrams,
  computeBuyFromPkr,
  computeSellFromGrams,
  computeSellFromPkr,
  expectedPkr,
  unitPrice,
} from '../../domain/trade-math';
import { MAX_NOTIONAL_PAISA, MIN_GOLD_UG, MIN_PKR_PAISA } from '../../domain/units';

const P = 4_000_000n; // Rs 40,000.00 per gram

describe('spreads', () => {
  it('uses 1.10 buy and 0.90 sell', () => {
    expect(BUY_SPREAD_BPS).toBe(11_000);
    expect(SELL_SPREAD_BPS).toBe(9_000);
    expect(unitPrice('buy', P).price).toBe(4_400_000n);
    expect(unitPrice('sell', P).price).toBe(3_600_000n);
  });

  it('rounds the buy price up and the sell price down', () => {
    // 1_000_001 × 1.1 = 1_100_001.1 -> ceil
    expect(unitPrice('buy', 1_000_001n).price).toBe(1_100_002n);
    // 1_000_009 × 0.9 = 900_008.1 -> floor
    expect(unitPrice('sell', 1_000_009n).price).toBe(900_008n);
  });

  it('applies the guardrail only above the computed buy price', () => {
    expect(unitPrice('buy', P, 4_300_000n)).toEqual({
      price: 4_400_000n,
      guardrailApplied: false,
    });
    expect(unitPrice('buy', P, 4_400_000n)).toEqual({
      price: 4_400_000n,
      guardrailApplied: false,
    });
    expect(unitPrice('buy', P, 4_500_000n)).toEqual({
      price: 4_500_000n,
      guardrailApplied: true,
    });
  });

  it('never applies the guardrail to a sell', () => {
    expect(unitPrice('sell', P, 9_000_000n)).toEqual({
      price: 3_600_000n,
      guardrailApplied: false,
    });
  });

  it('rejects invalid market prices and guardrails', () => {
    expect(() => unitPrice('buy', 0n)).toThrow(RangeError);
    expect(() => unitPrice('buy', P, -1n)).toThrow(RangeError);
  });
});

describe('buy maths', () => {
  it('splits a PKR input into gold and an exact charge', () => {
    const result = computeBuyFromPkr(1_000_000n, P);
    expect(result.goldMicrograms).toBe(250_000n);
    expect(result.pkrPaisa).toBe(1_000_000n);
  });

  it('charges from the rounded gold amount, not the input', () => {
    const result = computeBuyFromPkr(1_000_001n, 3_000_000n);
    expect(result.goldMicrograms).toBe(333_333n);
    expect(result.pkrPaisa).toBe(999_999n);
    expect(result.pkrPaisa).toBeLessThanOrEqual(1_000_001n);
  });

  it('leaves only sub-microgram dust on a PKR-input buy', () => {
    const input = 1_000_001n;
    const result = computeBuyFromPkr(input, 3_000_000n);
    const dustPaisa = input - result.pkrPaisa;
    expect(dustPaisa).toBe(2n);
    expect(dustPaisa * 1_000_000n).toBeLessThan(3_000_000n);
  });

  it('rounds a grams-input buy up', () => {
    const result = computeBuyFromGrams(1_000_000n, 4_000_001n);
    expect(result.goldMicrograms).toBe(1_000_000n);
    expect(result.pkrPaisa).toBe(4_000_001n);
  });
});

describe('sell maths', () => {
  it('rounds a grams-input sell down', () => {
    const result = computeSellFromGrams(333_333n, P);
    expect(result.goldMicrograms).toBe(333_333n);
    expect(result.pkrPaisa).toBe(1_333_332n);
  });

  it('splits a PKR-input sell into gold and an exact payout', () => {
    const result = computeSellFromPkr(1_000_000n, 3_000_000n);
    expect(result.goldMicrograms).toBe(333_333n);
    expect(result.pkrPaisa).toBe(999_999n);
    expect(result.pkrPaisa).toBeLessThanOrEqual(1_000_000n);
  });
});

describe('limits', () => {
  const base = {
    side: 'buy' as const,
    inputMode: 'pkr' as const,
    inputMinor: MIN_PKR_PAISA,
    goldMicrograms: 25_000n,
    pkrPaisa: MIN_PKR_PAISA,
  };

  it('accepts the exact PKR minimum', () => {
    expect(checkLimits(base).ok).toBe(true);
    expect(
      checkLimits({ ...base, inputMinor: MIN_PKR_PAISA - 1n, pkrPaisa: 99_999n }).code,
    ).toBe('BELOW_MIN');
  });

  it('accepts the exact gram minimum', () => {
    const gramsBase = {
      side: 'sell' as const,
      inputMode: 'grams' as const,
      inputMinor: MIN_GOLD_UG,
      goldMicrograms: MIN_GOLD_UG,
      pkrPaisa: 400_000n,
    };
    expect(checkLimits(gramsBase).ok).toBe(true);
    expect(
      checkLimits({ ...gramsBase, inputMinor: MIN_GOLD_UG - 1n }).code,
    ).toBe('BELOW_MIN');
  });

  it('rejects a trade that rounds to zero', () => {
    expect(
      checkLimits({
        side: 'buy',
        inputMode: 'pkr',
        inputMinor: MIN_PKR_PAISA,
        goldMicrograms: 0n,
        pkrPaisa: 0n,
      }).code,
    ).toBe('BELOW_MIN');
  });

  it('rejects above the maximum notional', () => {
    expect(
      checkLimits({
        side: 'buy',
        inputMode: 'pkr',
        inputMinor: MAX_NOTIONAL_PAISA + 1n,
        goldMicrograms: 1_000_000n,
        pkrPaisa: MAX_NOTIONAL_PAISA + 1n,
      }).code,
    ).toBe('ABOVE_MAX');

    expect(
      checkLimits({
        side: 'buy',
        inputMode: 'grams',
        inputMinor: 100_000_000n,
        goldMicrograms: 100_000_000n,
        pkrPaisa: MAX_NOTIONAL_PAISA + 1n,
      }).code,
    ).toBe('ABOVE_MAX');
  });

  it('accepts the exact maximum notional', () => {
    expect(
      checkLimits({
        side: 'buy',
        inputMode: 'pkr',
        inputMinor: MAX_NOTIONAL_PAISA,
        goldMicrograms: 25_000_000n,
        pkrPaisa: MAX_NOTIONAL_PAISA,
      }).ok,
    ).toBe(true);
  });
});

describe('receipt formula', () => {
  it('mirrors the Postgres CHECK for both sides', () => {
    for (const grams of [1n, 100_000n, 333_333n, 20_000_000n]) {
      for (const price of [3_500_001n, 4_000_000n, 4_412_345n]) {
        const buyInline = (grams * price + 999_999n) / 1_000_000n;
        const sellInline = (grams * price) / 1_000_000n;
        expect(expectedPkr('buy', grams, price)).toBe(buyInline);
        expect(expectedPkr('sell', grams, price)).toBe(sellInline);
      }
    }
  });

  it('ceilDiv matches the formula it implements', () => {
    expect(ceilDiv(10n, 3n)).toBe(4n);
    expect(ceilDiv(9n, 3n)).toBe(3n);
    expect(ceilDiv(0n, 3n)).toBe(0n);
  });
});
