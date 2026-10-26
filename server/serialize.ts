import { formatMicrograms, formatPaisa, toWire } from "../domain/units";
import type { PriceSnapshot } from "./pricing/price";
import type { QuoteRow, TradeRow } from "./db/repo";
import type { BalanceSnapshot } from "./db/repo";
import type { Confidence, SourceId } from "../domain/quorum";

const iso = (date: Date): string => date.toISOString();

export function priceWire(s: PriceSnapshot): unknown {
  return {
    price_paisa_per_gram: s.marketPaisaPerGram === null ? null : toWire(s.marketPaisaPerGram),
    price_display: s.marketPaisaPerGram === null ? null : `PKR ${formatPaisa(s.marketPaisaPerGram)} / g`,
    source: s.source,
    confidence: s.confidence,
    degraded: s.degraded,
    overridden: s.overridden,
    cycle_id: s.cycleId,
    fetched_at: iso(new Date(s.fetchedAtSeconds * 1000)),
    provider_at: s.providerSeconds === null ? null : iso(new Date(s.providerSeconds * 1000)),
    market_age_seconds: s.marketAgeSeconds,
    reason: s.reason,
    samples: s.samples.map((sample) => ({
      source: sample.source,
      ok: sample.ok,
      accepted: sample.accepted,
      selected: sample.selected,
      reason: sample.reason,
      price_paisa_per_gram: sample.pricePaisaPerGram === null ? null : toWire(sample.pricePaisaPerGram),
      price_display: sample.pricePaisaPerGram === null ? null : `PKR ${formatPaisa(sample.pricePaisaPerGram)} / g`,
    })),
  };
}

export function quoteWire(row: QuoteRow, opts: { now: Date }): unknown {
  return {
    id: row.id,
    side: row.side,
    status: row.status,
    input_mode: row.inputMode,
    input_minor: toWire(row.inputMinor),
    market_paisa_per_gram: toWire(row.marketPaisaPerGram),
    unit_paisa_per_gram: toWire(row.unitPaisaPerGram),
    spread_bps: row.spreadBps,
    gold_micrograms: toWire(row.goldMicrograms),
    pkr_paisa: toWire(row.pkrPaisa),
    // display strings: the client never does money arithmetic
    market_display: `PKR ${formatPaisa(row.marketPaisaPerGram)} / g`,
    unit_display: `PKR ${formatPaisa(row.unitPaisaPerGram)} / g`,
    gold_display: `${formatMicrograms(row.goldMicrograms)} g`,
    pkr_display: `PKR ${formatPaisa(row.pkrPaisa)}`,
    guardrail_paisa_per_gram: toWire(row.guardrailPaisaPerGram),
    guardrail_applied: row.guardrailApplied,
    price_source: row.priceSource,
    price_fetched_at: iso(row.priceFetchedAt),
    expires_at: iso(row.expiresAt),
    created_at: iso(row.createdAt),
    now: iso(opts.now),
  };
}

export function tradeWire(
  row: TradeRow,
  opts: { balances?: BalanceSnapshot; balancesBefore?: BalanceSnapshot },
): unknown {
  return {
    id: row.id,
    quote_id: row.quoteId,
    side: row.side,
    gold_micrograms: toWire(row.goldMicrograms),
    pkr_paisa: toWire(row.pkrPaisa),
    market_paisa_per_gram: toWire(row.marketPaisaPerGram),
    unit_paisa_per_gram: toWire(row.unitPaisaPerGram),
    spread_bps: row.spreadBps,
    guardrail_paisa_per_gram: toWire(row.guardrailPaisaPerGram),
    guardrail_applied: row.guardrailApplied,
    price_source: row.priceSource,
    // display strings
    gold_display: `${formatMicrograms(row.goldMicrograms)} g`,
    pkr_display: `PKR ${formatPaisa(row.pkrPaisa)}`,
    unit_display: `PKR ${formatPaisa(row.unitPaisaPerGram)} / g`,
    market_display: `PKR ${formatPaisa(row.marketPaisaPerGram)} / g`,
    price_fetched_at: iso(row.priceFetchedAt),
    quote_created_at: iso(row.quoteCreatedAt),
    settled_at: iso(row.settledAt),
    balances_after: opts.balances ? balancesWire(opts.balances) : undefined,
    balances_before: opts.balancesBefore ? balancesWire(opts.balancesBefore) : undefined,
  };
}

export function balancesWire(b: BalanceSnapshot): unknown {
  return {
    pkr_paisa: toWire(b.pkrPaisa),
    user_gold_micrograms: toWire(b.userGoldMicrograms),
    platform_gold_micrograms: toWire(b.platformGoldMicrograms),
    pkr_display: `PKR ${formatPaisa(b.pkrPaisa)}`,
    user_gold_display: `${formatMicrograms(b.userGoldMicrograms)} g`,
    platform_gold_display: `${formatMicrograms(b.platformGoldMicrograms)} g`,
  };
}

export function settingsWire(s: {
  guardrailPaisaPerGram: bigint;
  quoteTtlSeconds: number;
  divergenceThresholdBps: number;
  maxPriceAgeSeconds: number;
  sourceAOn: boolean;
  sourceBOn: boolean;
  sourceCOn: boolean;
  sourceCBasisBps: number;
  priceOverridePaisa: bigint | null;
  forcePaused: boolean;
}): unknown {
  return {
    guardrail_paisa_per_gram: toWire(s.guardrailPaisaPerGram),
    quote_ttl_seconds: s.quoteTtlSeconds,
    divergence_threshold_bps: s.divergenceThresholdBps,
    max_price_age_seconds: s.maxPriceAgeSeconds,
    source_a_on: s.sourceAOn,
    source_b_on: s.sourceBOn,
    source_c_on: s.sourceCOn,
    source_c_basis_bps: s.sourceCBasisBps,
    price_override_paisa: s.priceOverridePaisa === null ? null : toWire(s.priceOverridePaisa),
    force_paused: s.forcePaused,
  };
}

export type { Confidence, SourceId };
