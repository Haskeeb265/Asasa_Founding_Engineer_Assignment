import type {
  Balances,
  PriceRow,
  QuoteRow,
  SettingsRow,
  TradeRow,
} from './db/repo';
import { TOTAL_GOLD_UG } from './db/seed-values';
import { sourceLabel } from './pricing/settings-like';
import type { PriceSnapshot } from './pricing/cycle';
import { unitPrice } from '../domain/trade-math';

/** Wire shapes use snake_case field names that carry their unit. */

export function balanceView(balances: Balances) {
  return {
    pkr_paisa: balances.pkrPaisa,
    user_gold_micrograms: balances.userGoldMicrograms,
    platform_gold_micrograms: balances.platformGoldMicrograms,
    total_gold_micrograms: TOTAL_GOLD_UG,
  };
}

export function settingsView(settings: SettingsRow) {
  return {
    guardrail_paisa_per_gram: settings.guardrailPaisaPerGram,
    quote_ttl_seconds: settings.quoteTtlSeconds,
    divergence_threshold_bps: settings.divergenceThresholdBps,
    max_price_age_seconds: settings.maxPriceAgeSeconds,
    price_fetch_interval_seconds: settings.priceFetchIntervalSeconds,
    source_a_on: settings.sourceAOn,
    source_b_on: settings.sourceBOn,
    source_c_on: settings.sourceCOn,
    source_c_basis_bps: settings.sourceCBasisBps,
    price_override_paisa: settings.priceOverridePaisa,
    force_paused: settings.forcePaused,
    updated_at: settings.updatedAt,
  };
}

export function quoteView(quote: QuoteRow, now = new Date()) {
  const secondsRemaining = Math.max(
    0,
    Math.floor((quote.expiresAt.getTime() - now.getTime()) / 1000),
  );
  return {
    id: quote.id,
    side: quote.side,
    status: quote.status,
    input_mode: quote.inputMode,
    input_minor: quote.inputMinor,
    market_paisa_per_gram: quote.marketPaisaPerGram,
    unit_paisa_per_gram: quote.unitPaisaPerGram,
    spread_bps: quote.spreadBps,
    gold_micrograms: quote.goldMicrograms,
    pkr_paisa: quote.pkrPaisa,
    guardrail_paisa_per_gram: quote.guardrailPaisaPerGram,
    guardrail_applied: quote.guardrailApplied,
    price_source: quote.priceSource,
    price_cycle_id: quote.priceCycleId,
    price_fetched_at: quote.priceFetchedAt,
    expires_at: quote.expiresAt,
    created_at: quote.createdAt,
    settled_at: quote.settledAt,
    rejection_reason: quote.rejectionReason,
    seconds_remaining: secondsRemaining,
  };
}

export function tradeView(trade: TradeRow) {
  return {
    id: trade.id,
    quote_id: trade.quoteId,
    side: trade.side,
    gold_micrograms: trade.goldMicrograms,
    pkr_paisa: trade.pkrPaisa,
    market_paisa_per_gram: trade.marketPaisaPerGram,
    unit_paisa_per_gram: trade.unitPaisaPerGram,
    spread_bps: trade.spreadBps,
    guardrail_paisa_per_gram: trade.guardrailPaisaPerGram,
    guardrail_applied: trade.guardrailApplied,
    price_source: trade.priceSource,
    source_label: sourceLabel(trade.priceSource, 'live'),
    price_fetched_at: trade.priceFetchedAt,
    quote_created_at: trade.quoteCreatedAt,
    settled_at: trade.settledAt,
  };
}

export function pricePanelView(
  snapshot: PriceSnapshot | null,
  settings: SettingsRow,
  now: Date,
) {
  if (
    !snapshot ||
    snapshot.source === null ||
    snapshot.paisa_per_gram === null
  ) {
    return null;
  }

  const market = snapshot.paisa_per_gram;
  const buy = unitPrice('buy', market, settings.guardrailPaisaPerGram);
  const sell = unitPrice('sell', market);
  const selected = snapshot.samples.find((sample) => sample.selected);
  const providerAt = selected?.provider_at ?? null;

  return {
    source: snapshot.source,
    source_label: sourceLabel(snapshot.source, snapshot.kind),
    market_paisa_per_gram: market,
    buy_paisa_per_gram: buy.price,
    sell_paisa_per_gram: sell.price,
    guardrail_applied: buy.guardrailApplied,
    fetched_at: snapshot.fetched_at,
    fetch_age_seconds: Math.max(
      0,
      Math.floor((now.getTime() - snapshot.fetched_at.getTime()) / 1000),
    ),
    provider_at: providerAt,
    market_age_seconds:
      providerAt === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - providerAt.getTime()) / 1000)),
    status: snapshot.status,
    degraded: snapshot.degraded,
    degraded_reason: snapshot.degraded_reason,
    kind: snapshot.kind,
    samples: snapshot.samples.map((sample) => ({
      source: sample.source,
      price_paisa_per_gram: sample.price_paisa_per_gram,
      accepted: sample.accepted,
      selected: sample.selected,
      reason: sample.reason,
      provider_at: sample.provider_at,
      ...(sample.note ? { note: sample.note } : {}),
    })),
  };
}

export function priceRowView(row: PriceRow) {
  return {
    id: row.id,
    cycle_id: row.cycleId,
    fetched_at: row.fetchedAt,
    source: row.source,
    price_paisa_per_gram: row.pricePaisaPerGram,
    accepted: row.accepted,
    selected: row.selected,
    reason: row.reason,
  };
}
