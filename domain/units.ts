/**
 * Pure unit and money helpers. No I/O, no clock, no server imports.
 *
 * Storage units:
 *  - PKR:   paisa (1/100 PKR), integer
 *  - Gold:  microgram (1 g = 1_000_000 µg), integer
 *  - Price: paisa per gram, integer
 */

export const GRAMS_PER_TROY_OZ = 31.1034768;
export const MICRO = 1_000_000n;

/** Rs 1,000.00 */
export const MIN_PKR_PAISA = 100_000n;
/** 0.1 g */
export const MIN_GOLD_UG = 100_000n;
/** Rs 1,000,000.00 */
export const MAX_NOTIONAL_PAISA = 100_000_000n;

export type AmountErrorCode =
  | 'INVALID_AMOUNT'
  | 'AMOUNT_NOT_POSITIVE'
  | 'TOO_MANY_DECIMALS';

export class AmountError extends Error {
  readonly code: AmountErrorCode;

  constructor(code: AmountErrorCode, message: string) {
    super(message);
    this.name = 'AmountError';
    this.code = code;
  }
}

const AMOUNT_RE = /^-?\d+(\.\d+)?$/;

/**
 * Parse a wire amount (JSON string only) into integer minor units.
 * Uses string manipulation and BigInt; never parseFloat.
 */
export function parseAmount(raw: unknown, maxDecimals: number): bigint {
  if (typeof raw !== 'string' || !AMOUNT_RE.test(raw)) {
    throw new AmountError(
      'INVALID_AMOUNT',
      'Amount must be a decimal string such as "1000.00".',
    );
  }

  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, frac = ''] = unsigned.split('.');

  if (frac.length > maxDecimals) {
    throw new AmountError(
      'TOO_MANY_DECIMALS',
      `Amount accepts at most ${maxDecimals} decimal place(s).`,
    );
  }

  const scale = 10n ** BigInt(maxDecimals);
  const padded = frac.padEnd(maxDecimals, '0');
  const value = BigInt(whole) * scale + (padded.length > 0 ? BigInt(padded) : 0n);

  if (negative || value <= 0n) {
    throw new AmountError('AMOUNT_NOT_POSITIVE', 'Amount must be greater than zero.');
  }

  return value;
}

/** Parse a PKR string into paisa (2 decimal places). */
export function parsePkr(raw: unknown): bigint {
  return parseAmount(raw, 2);
}

/** Parse a grams string into micrograms (6 decimal places). */
export function parseGrams(raw: unknown): bigint {
  return parseAmount(raw, 6);
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than zero.`);
  }
}

/** Ingestion rounding for A (USD/oz) and C (USD/oz futures, basis-adjusted). */
export function ingestUsdPerTroyOz(usdPerOz: number, usdPkr: number): bigint {
  assertPositiveFinite('USD per troy oz', usdPerOz);
  assertPositiveFinite('USD/PKR', usdPkr);
  const paisa = Math.round((usdPerOz * usdPkr * 100) / GRAMS_PER_TROY_OZ);
  if (!Number.isFinite(paisa) || paisa <= 0) {
    throw new RangeError('Ingested price is not a positive finite number.');
  }
  return BigInt(paisa);
}

/** Ingestion rounding for B (already PKR per troy oz). */
export function ingestPkrPerTroyOz(pkrPerOz: number): bigint {
  assertPositiveFinite('PKR per troy oz', pkrPerOz);
  const paisa = Math.round((pkrPerOz * 100) / GRAMS_PER_TROY_OZ);
  if (!Number.isFinite(paisa) || paisa <= 0) {
    throw new RangeError('Ingested price is not a positive finite number.');
  }
  return BigInt(paisa);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** paisa -> "Rs 12,345.67" (negative amounts prefixed with "-"). */
export function formatPkr(paisa: bigint): string {
  const negative = paisa < 0n;
  const abs = negative ? -paisa : paisa;
  const whole = abs / 100n;
  const cents = abs % 100n;
  const sign = negative ? '-' : '';
  return `${sign}Rs ${groupThousands(whole.toString())}.${cents
    .toString()
    .padStart(2, '0')}`;
}

/** micrograms -> "1.278241 g" (trailing zeros trimmed). */
export function formatGrams(micrograms: bigint): string {
  const negative = micrograms < 0n;
  const abs = negative ? -micrograms : micrograms;
  const whole = abs / MICRO;
  const frac = (abs % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return frac.length > 0
    ? `${sign}${groupThousands(whole.toString())}.${frac} g`
    : `${sign}${groupThousands(whole.toString())} g`;
}

/** paisa per gram -> "Rs 3,911.26/g". */
export function formatPricePerGram(paisaPerGram: bigint): string {
  return `${formatPkr(paisaPerGram)}/g`;
}

/**
 * Recursively convert bigint -> decimal string and Date -> ISO string.
 * This is the one wire-safe projection used before any JSON response.
 */
export function toWire(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toWire(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toWire(item);
    }
    return out;
  }
  return value;
}
