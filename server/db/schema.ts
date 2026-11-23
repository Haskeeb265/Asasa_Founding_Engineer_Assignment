import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** All money columns are bigint in minor units; pg returns them as strings. */
const bigintColumn = (name: string) => bigint(name, { mode: 'bigint' });

export const balances = pgTable(
  'balances',
  {
    key: text('key').primaryKey(),
    unit: text('unit').notNull(),
    amount: bigintColumn('amount').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'balances_key_check',
      sql`${t.key} in ('pkr', 'user_gold', 'platform_gold')`,
    ),
    check('balances_amount_check', sql`${t.amount} >= 0`),
    check(
      'balances_unit_check',
      sql`(${t.key} = 'pkr' and ${t.unit} = 'paisa') or (${t.key} <> 'pkr' and ${t.unit} = 'microgram')`,
    ),
  ],
);

export const settings = pgTable(
  'settings',
  {
    id: boolean('id').primaryKey().default(true),
    guardrailPaisaPerGram: bigintColumn('guardrail_paisa_per_gram')
      .notNull()
      .default(0n),
    quoteTtlSeconds: integer('quote_ttl_seconds').notNull().default(75),
    divergenceThresholdBps: integer('divergence_threshold_bps')
      .notNull()
      .default(100),
    maxPriceAgeSeconds: integer('max_price_age_seconds').notNull().default(600),
    priceFetchIntervalSeconds: integer('price_fetch_interval_seconds')
      .notNull()
      .default(300),
    sourceAOn: boolean('source_a_on').notNull().default(true),
    sourceBOn: boolean('source_b_on').notNull().default(true),
    sourceCOn: boolean('source_c_on').notNull().default(true),
    sourceCBasisBps: integer('source_c_basis_bps').notNull().default(28),
    priceOverridePaisa: bigintColumn('price_override_paisa'),
    forcePaused: boolean('force_paused').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('settings_single_row_check', sql`${t.id}`),
    check(
      'settings_guardrail_check',
      sql`${t.guardrailPaisaPerGram} >= 0`,
    ),
    check(
      'settings_fetch_interval_check',
      sql`${t.priceFetchIntervalSeconds} between 1 and 86400`,
    ),
    check(
      'settings_c_basis_check',
      sql`${t.sourceCBasisBps} between -500 and 500`,
    ),
    check(
      'settings_override_check',
      sql`${t.priceOverridePaisa} is null or ${t.priceOverridePaisa} > 0`,
    ),
  ],
);

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    side: text('side').notNull(),
    status: text('status').notNull(),
    inputMode: text('input_mode').notNull(),
    inputMinor: bigintColumn('input_minor').notNull(),
    marketPaisaPerGram: bigintColumn('market_paisa_per_gram').notNull(),
    unitPaisaPerGram: bigintColumn('unit_paisa_per_gram').notNull(),
    spreadBps: integer('spread_bps').notNull(),
    goldMicrograms: bigintColumn('gold_micrograms').notNull(),
    pkrPaisa: bigintColumn('pkr_paisa').notNull(),
    guardrailPaisaPerGram: bigintColumn('guardrail_paisa_per_gram')
      .notNull()
      .default(0n),
    guardrailApplied: boolean('guardrail_applied').notNull().default(false),
    priceSource: text('price_source').notNull(),
    priceCycleId: uuid('price_cycle_id'),
    priceFetchedAt: timestamp('price_fetched_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
  },
  (t) => [
    check('quotes_side_check', sql`${t.side} in ('buy', 'sell')`),
    check(
      'quotes_status_check',
      sql`${t.status} in ('active', 'confirmed', 'settled', 'expired', 'cancelled', 'rejected')`,
    ),
    check(
      'quotes_input_mode_check',
      sql`${t.inputMode} in ('pkr', 'grams')`,
    ),
    check('quotes_gold_positive_check', sql`${t.goldMicrograms} > 0`),
    check('quotes_pkr_positive_check', sql`${t.pkrPaisa} > 0`),
    check('quotes_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
    index('quotes_status_expires_idx').on(t.status, t.expiresAt),
    index('quotes_created_idx').on(t.createdAt.desc()),
  ],
);

export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    quoteId: uuid('quote_id')
      .notNull()
      .unique()
      .references(() => quotes.id),
    side: text('side').notNull(),
    goldMicrograms: bigintColumn('gold_micrograms').notNull(),
    pkrPaisa: bigintColumn('pkr_paisa').notNull(),
    marketPaisaPerGram: bigintColumn('market_paisa_per_gram').notNull(),
    unitPaisaPerGram: bigintColumn('unit_paisa_per_gram').notNull(),
    spreadBps: integer('spread_bps').notNull(),
    guardrailPaisaPerGram: bigintColumn('guardrail_paisa_per_gram')
      .notNull()
      .default(0n),
    guardrailApplied: boolean('guardrail_applied').notNull().default(false),
    priceSource: text('price_source').notNull(),
    priceFetchedAt: timestamp('price_fetched_at', { withTimezone: true }).notNull(),
    quoteCreatedAt: timestamp('quote_created_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('trades_side_check', sql`${t.side} in ('buy', 'sell')`),
    check('trades_gold_positive_check', sql`${t.goldMicrograms} > 0`),
    check('trades_pkr_positive_check', sql`${t.pkrPaisa} > 0`),
    check(
      'pkr_is_exact',
      sql`${t.pkrPaisa} = case when ${t.side} = 'buy' then (${t.goldMicrograms} * ${t.unitPaisaPerGram} + 999999) / 1000000 else (${t.goldMicrograms} * ${t.unitPaisaPerGram}) / 1000000 end`,
    ),
    index('trades_settled_idx').on(t.settledAt.desc()),
  ],
);

export const prices = pgTable(
  'prices',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    cycleId: uuid('cycle_id').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    source: text('source').notNull(),
    pricePaisaPerGram: bigintColumn('price_paisa_per_gram'),
    accepted: boolean('accepted').notNull(),
    selected: boolean('selected').notNull().default(false),
    reason: text('reason').notNull(),
  },
  (t) => [
    check(
      'prices_source_check',
      sql`${t.source} in ('A_pakgold', 'B_goldprice', 'C_yahoo')`,
    ),
    unique('prices_cycle_source_unique').on(t.cycleId, t.source),
    index('prices_fetched_idx').on(t.fetchedAt.desc()),
    index('prices_selected_idx').on(t.selected, t.fetchedAt.desc()),
  ],
);

