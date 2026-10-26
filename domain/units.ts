/**
 * Units are the whole game here, so every value carries its unit in the name.
 *
 *   PKR  -> paisa      (bigint, 1 PKR = 100)
 *   gold -> microgram  (bigint, 1 g = 1_000_000)
 *   price-> paisa per gram
 *
 * No float is ever produced below the ingestion boundary, and the ingestion
 * function is the only place a round() on money happens.
 */

export const TROY_OUNCE_IN_GRAMS = 31.1034768;

export const MICROGRAMS_PER_GRAM = 1_000_000n;
export const PAISA_PER_PKR = 100n;

/** Rs 1,000 */
export const MIN_TRADE_PKR_PAISA = 100_000n;
/** 0.1 g */
export const MIN_TRADE_GOLD_MICRO = 100_000n;
/** Rs 1,000,000 */
export const MAX_NOTIONAL_PKR_PAISA = 100_000_000n;

export type ParseFailure =
  | "INVALID_AMOUNT"
  | "TOO_MANY_DECIMALS"
  | "AMOUNT_NOT_POSITIVE"
  | "BELOW_MIN"
  | "ABOVE_MAX"
  | "PRICE_UNAVAILABLE";

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; code: ParseFailure; message: string };

const fail = <T>(code: ParseFailure, message: string): Parsed<T> => ({
  ok: false,
  code,
  message,
});

/**
 * Accepts "50000", "50,000", "50000.25" — rejects "1e5", "+5", "-5", "abc",
 * "5.", ".5", " 5 0 " and anything with more decimals than the unit allows.
 */
const DECIMAL_RE = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/;

export function parseMinor(raw: unknown, decimals: number, label: string): Parsed<bigint> {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return fail("INVALID_AMOUNT", `Enter ${label} as a number.`);
  }
  if (typeof raw === "number" && !Number.isFinite(raw)) {
    return fail("INVALID_AMOUNT", `Enter ${label} as a finite number.`);
  }

  const text = String(raw).trim();
  if (text.length === 0) return fail("INVALID_AMOUNT", `Enter ${label}.`);
  if (text.length > 32) return fail("INVALID_AMOUNT", `That ${label} amount is too long.`);

  const match = DECIMAL_RE.exec(text);
  if (!match) {
    return fail(
      "INVALID_AMOUNT",
      `Enter ${label} as plain digits, optionally with commas and a decimal point.`,
    );
  }

  const fraction = match[1] ?? "";
  if (fraction.length > decimals) {
    return fail(
      "TOO_MANY_DECIMALS",
      `${label} allows at most ${decimals} decimal place${decimals === 1 ? "" : "s"}.`,
    );
  }

  const wholeDigits = text.split(".")[0]?.replace(/,/g, "") ?? "0";
  if (!/^\d+$/.test(wholeDigits)) {
    return fail("INVALID_AMOUNT", `Enter ${label} as plain digits.`);
  }

  const scale = 10n ** BigInt(decimals);
  const whole = BigInt(wholeDigits) * scale;
  const part = fraction.length === 0 ? 0n : BigInt(fraction.padEnd(decimals, "0"));

  return { ok: true, value: whole + part };
}

/** PKR typed by the user -> paisa. */
export function parsePkrAmount(raw: unknown): Parsed<bigint> {
  const parsed = parseMinor(raw, 2, "PKR");
  if (!parsed.ok) return parsed;
  if (parsed.value <= 0n) return fail("AMOUNT_NOT_POSITIVE", "Enter an amount above zero.");
  if (parsed.value < MIN_TRADE_PKR_PAISA) {
    return fail("BELOW_MIN", "The smallest trade is Rs 1,000.");
  }
  if (parsed.value > MAX_NOTIONAL_PKR_PAISA) {
    return fail("ABOVE_MAX", "The largest trade is Rs 1,000,000.");
  }
  return parsed;
}

/** Grams typed by the user -> microgram. */
export function parseGoldAmount(raw: unknown): Parsed<bigint> {
  const parsed = parseMinor(raw, 6, "grams");
  if (!parsed.ok) return parsed;
  if (parsed.value <= 0n) return fail("AMOUNT_NOT_POSITIVE", "Enter an amount above zero.");
  if (parsed.value < MIN_TRADE_GOLD_MICRO) {
    return fail("BELOW_MIN", "The smallest trade is 0.1 g.");
  }
  return parsed;
}

/** PKR per troy ounce -> paisa per gram. The ONLY rounding on an ingested price. */
export function marketPaisaPerGramFromPkrPerOz(pkrPerOz: number): bigint {
  assertPositiveFinite(pkrPerOz, "pkrPerOz");
  return BigInt(Math.round((pkrPerOz * 100) / TROY_OUNCE_IN_GRAMS));
}

/** USD per troy ounce + USD/PKR -> paisa per gram. */
export function marketPaisaPerGramFromUsdPerOz(usdPerOz: number, pkrPerUsd: number): bigint {
  assertPositiveFinite(usdPerOz, "usdPerOz");
  assertPositiveFinite(pkrPerUsd, "pkrPerUsd");
  return BigInt(Math.round((usdPerOz * pkrPerUsd * 100) / TROY_OUNCE_IN_GRAMS));
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number, received ${value}`);
  }
}

/** bigint -> JSON-safe number. Refuses anything that could lose precision. */
export function toWire(value: bigint): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError(`Value ${value} exceeds the safe integer range and cannot be serialised`);
  }
  return asNumber;
}

const withThousands = (digits: string): string =>
  digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 5000000n -> "50,000.00" */
export function formatPaisa(paisa: bigint): string {
  const negative = paisa < 0n;
  const abs = negative ? -paisa : paisa;
  const whole = (abs / PAISA_PER_PKR).toString();
  const cents = (abs % PAISA_PER_PKR).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${withThousands(whole)}.${cents}`;
}

/** 1278241n -> "1.278241" */
export function formatMicrograms(micrograms: bigint): string {
  const negative = micrograms < 0n;
  const abs = negative ? -micrograms : micrograms;
  const whole = (abs / MICROGRAMS_PER_GRAM).toString();
  const part = (abs % MICROGRAMS_PER_GRAM).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${withThousands(whole)}.${part}`;
}
