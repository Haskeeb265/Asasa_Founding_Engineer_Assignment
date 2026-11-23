/**
 * Pure trade mathematics. The only place trade rounding happens.
 * All values are integer minor units (paisa, micrograms) held in BigInt.
 */

import {
  MAX_NOTIONAL_PAISA,
  MICRO,
  MIN_GOLD_UG,
  MIN_PKR_PAISA,
  formatGrams,
  formatPkr,
} from './units';

export type Side = 'buy' | 'sell';
export type InputMode = 'pkr' | 'grams';

/** ×1.10 expressed as basis points. */
export const BUY_SPREAD_BPS = 11_000;
/** ×0.90 expressed as basis points. */
export const SELL_SPREAD_BPS = 9_000;

export const BPS_DENOMINATOR = 10_000n;

/** Ceiling division for positive BigInt values. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  return (numerator + denominator - 1n) / denominator;
}

export interface UnitPrice {
  /** Paisa per gram charged/paid. */
  price: bigint;
  guardrailApplied: boolean;
}

/**
 * buy  = max(ceil(market × 11000 / 10000), guardrail)
 * sell = floor(market × 9000 / 10000)
 */
export function unitPrice(side: Side, market: bigint, guardrail = 0n): UnitPrice {
  if (market <= 0n) throw new RangeError('market price must be positive');
  if (guardrail < 0n) throw new RangeError('guardrail must not be negative');

  if (side === 'buy') {
    const spread = ceilDiv(
      market * BigInt(BUY_SPREAD_BPS),
      BPS_DENOMINATOR,
    );
    if (guardrail > spread) {
      return { price: guardrail, guardrailApplied: true };
    }
    return { price: spread, guardrailApplied: false };
  }

  return {
    price: (market * BigInt(SELL_SPREAD_BPS)) / BPS_DENOMINATOR,
    guardrailApplied: false,
  };
}

export interface TradeAmounts {
  goldMicrograms: bigint;
  pkrPaisa: bigint;
}

/** Buy with a PKR input: G = floor(A_in × 1e6 / P), A = ceil(G × P / 1e6). */
export function computeBuyFromPkr(inputPaisa: bigint, price: bigint): TradeAmounts {
  const goldMicrograms = (inputPaisa * MICRO) / price;
  const pkrPaisa = ceilDiv(goldMicrograms * price, MICRO);
  return { goldMicrograms, pkrPaisa };
}

/** Buy with a grams input: A = ceil(G × P / 1e6). */
export function computeBuyFromGrams(
  goldMicrograms: bigint,
  price: bigint,
): TradeAmounts {
  return {
    goldMicrograms,
    pkrPaisa: ceilDiv(goldMicrograms * price, MICRO),
  };
}

/** Sell with a grams input: A = floor(G × P / 1e6). */
export function computeSellFromGrams(
  goldMicrograms: bigint,
  price: bigint,
): TradeAmounts {
  return {
    goldMicrograms,
    pkrPaisa: (goldMicrograms * price) / MICRO,
  };
}

/** Sell with a PKR input: G = floor(A_in × 1e6 / P), A = floor(G × P / 1e6). */
export function computeSellFromPkr(inputPaisa: bigint, price: bigint): TradeAmounts {
  const goldMicrograms = (inputPaisa * MICRO) / price;
  const pkrPaisa = (goldMicrograms * price) / MICRO;
  return { goldMicrograms, pkrPaisa };
}

export type LimitCode = 'BELOW_MIN' | 'ABOVE_MAX';

export interface LimitResult {
  ok: boolean;
  code?: LimitCode;
  message: string;
}

export interface LimitCheckInput {
  side: Side;
  inputMode: InputMode;
  inputMinor: bigint;
  goldMicrograms: bigint;
  pkrPaisa: bigint;
}

/**
 * Min trade is compared in the input's own unit; max notional is compared on
 * the computed PKR amount plus, for PKR-input paths, the named input itself.
 */
export function checkLimits(input: LimitCheckInput): LimitResult {
  const { inputMode, inputMinor, goldMicrograms, pkrPaisa } = input;

  if (inputMode === 'pkr' && inputMinor < MIN_PKR_PAISA) {
    return {
      ok: false,
      code: 'BELOW_MIN',
      message: `Minimum trade is ${formatPkr(MIN_PKR_PAISA)}.`,
    };
  }
  if (inputMode === 'grams' && inputMinor < MIN_GOLD_UG) {
    return {
      ok: false,
      code: 'BELOW_MIN',
      message: `Minimum trade is ${formatGrams(MIN_GOLD_UG)}.`,
    };
  }
  if (goldMicrograms <= 0n || pkrPaisa <= 0n) {
    return {
      ok: false,
      code: 'BELOW_MIN',
      message: 'The trade rounds to zero at this price.',
    };
  }
  if (pkrPaisa > MAX_NOTIONAL_PAISA) {
    return {
      ok: false,
      code: 'ABOVE_MAX',
      message: `Maximum trade is ${formatPkr(MAX_NOTIONAL_PAISA)}.`,
    };
  }
  if (inputMode === 'pkr' && inputMinor > MAX_NOTIONAL_PAISA) {
    return {
      ok: false,
      code: 'ABOVE_MAX',
      message: `Maximum trade is ${formatPkr(MAX_NOTIONAL_PAISA)}.`,
    };
  }

  return { ok: true, message: 'Within trade limits.' };
}

/**
 * TypeScript mirror of the `trades.pkr_is_exact` database CHECK.
 * Buy rounds up, sell rounds down; positive values only.
 */
export function expectedPkr(side: Side, goldMicrograms: bigint, price: bigint): bigint {
  if (side === 'buy') return ceilDiv(goldMicrograms * price, MICRO);
  return (goldMicrograms * price) / MICRO;
}
