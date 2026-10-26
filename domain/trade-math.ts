import {
  MICROGRAMS_PER_GRAM,
  MAX_NOTIONAL_PKR_PAISA,
  MIN_TRADE_GOLD_MICRO,
  MIN_TRADE_PKR_PAISA,
  type Parsed,
} from "./units";

export type Side = "buy" | "sell";
export type InputMode = "pkr" | "gold";

/** The brief's spreads, as basis points so every step stays integer. */
export const BUY_SPREAD_BPS = 11000n; // market x 1.10
export const SELL_SPREAD_BPS = 9000n; // market x 0.90
const BPS_DENOMINATOR = 10000n;

const divCeil = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

/** Round up: we never sell gold for less than market x 1.10. */
export function buyUnitPaisaPerGram(marketPaisaPerGram: bigint): bigint {
  return divCeil(marketPaisaPerGram * BUY_SPREAD_BPS, BPS_DENOMINATOR);
}

/** Round down: we never buy gold back for more than market x 0.90. */
export function sellUnitPaisaPerGram(marketPaisaPerGram: bigint): bigint {
  return (marketPaisaPerGram * SELL_SPREAD_BPS) / BPS_DENOMINATOR;
}

export interface QuoteTerms {
  side: Side;
  inputMode: InputMode;
  inputMinor: bigint;
  marketPaisaPerGram: bigint;
  unitPaisaPerGram: bigint;
  spreadBps: number;
  goldMicrograms: bigint;
  pkrPaisa: bigint;
  guardrailPaisaPerGram: bigint;
  guardrailApplied: boolean;
}

export interface BuildQuoteInput {
  side: Side;
  inputMode: InputMode;
  /** paisa when inputMode is 'pkr', micrograms when it is 'gold' */
  inputMinor: bigint;
  marketPaisaPerGram: bigint;
  guardrailPaisaPerGram: bigint;
}

/**
 * Turns what the user typed into the exact pair of numbers that will move:
 * `goldMicrograms` and `pkrPaisa`. Grams are canonical and PKR is always
 * derived from them, so every quote and receipt satisfies
 * `pkrPaisa === f(goldMicrograms, unitPaisaPerGram)` exactly, with no leftover
 * fraction to explain.
 *
 * Rounding always favours the platform by at most one paisa:
 *   buy  -> charge rounds up
 *   sell -> payout rounds down
 */
export function buildQuote(input: BuildQuoteInput): Parsed<QuoteTerms> {
  const { side, inputMode, inputMinor, marketPaisaPerGram, guardrailPaisaPerGram } = input;

  if (marketPaisaPerGram <= 0n) {
    return { ok: false, code: "PRICE_UNAVAILABLE", message: "No usable market price." };
  }
  if (inputMinor <= 0n) {
    return { ok: false, code: "AMOUNT_NOT_POSITIVE", message: "Enter an amount above zero." };
  }

  const floor = inputMode === "pkr" ? MIN_TRADE_PKR_PAISA : MIN_TRADE_GOLD_MICRO;
  if (inputMinor < floor) {
    return {
      ok: false,
      code: "BELOW_MIN",
      message: inputMode === "pkr" ? "The smallest trade is Rs 1,000." : "The smallest trade is 0.1 g.",
    };
  }

  let unitPaisaPerGram: bigint;
  let guardrailApplied = false;

  if (side === "buy") {
    const spreadPrice = buyUnitPaisaPerGram(marketPaisaPerGram);
    guardrailApplied = guardrailPaisaPerGram > spreadPrice;
    unitPaisaPerGram = guardrailApplied ? guardrailPaisaPerGram : spreadPrice;
  } else {
    unitPaisaPerGram = sellUnitPaisaPerGram(marketPaisaPerGram);
  }

  if (unitPaisaPerGram <= 0n) {
    return { ok: false, code: "PRICE_UNAVAILABLE", message: "No usable market price." };
  }

  let goldMicrograms: bigint;
  let pkrPaisa: bigint;

  if (side === "buy" && inputMode === "pkr") {
    // floor the grams, then re-derive the charge from those grams
    goldMicrograms = (inputMinor * MICROGRAMS_PER_GRAM) / unitPaisaPerGram;
    pkrPaisa = divCeil(goldMicrograms * unitPaisaPerGram, MICROGRAMS_PER_GRAM);
  } else if (side === "buy") {
    goldMicrograms = inputMinor;
    pkrPaisa = divCeil(goldMicrograms * unitPaisaPerGram, MICROGRAMS_PER_GRAM);
  } else if (inputMode === "pkr") {
    // selling to receive a PKR target: never overpay, so floor both steps
    goldMicrograms = (inputMinor * MICROGRAMS_PER_GRAM) / unitPaisaPerGram;
    pkrPaisa = (goldMicrograms * unitPaisaPerGram) / MICROGRAMS_PER_GRAM;
  } else {
    goldMicrograms = inputMinor;
    pkrPaisa = (goldMicrograms * unitPaisaPerGram) / MICROGRAMS_PER_GRAM;
  }

  if (goldMicrograms <= 0n || pkrPaisa <= 0n) {
    return {
      ok: false,
      code: "BELOW_MIN",
      message: "That amount is too small to trade.",
    };
  }
  if (pkrPaisa > MAX_NOTIONAL_PKR_PAISA) {
    return { ok: false, code: "ABOVE_MAX", message: "The largest trade is Rs 1,000,000." };
  }
  // Safety net: a user who names a PKR amount must never be charged more than it.
  if (inputMode === "pkr" && pkrPaisa > inputMinor) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      message: "Rounding produced a charge above the amount entered.",
    };
  }

  return {
    ok: true,
    value: {
      side,
      inputMode,
      inputMinor,
      marketPaisaPerGram,
      unitPaisaPerGram,
      spreadBps: Number(side === "buy" ? BUY_SPREAD_BPS : SELL_SPREAD_BPS),
      goldMicrograms,
      pkrPaisa,
      guardrailPaisaPerGram,
      guardrailApplied,
    },
  };
}
