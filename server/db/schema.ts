import { sql } from "drizzle-orm";
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
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Units convention, applied everywhere:
 *   PKR        -> paisa        (1 PKR = 100 paisa)
 *   gold       -> microgram    (1 g   = 1_000_000 microgram)
 *   price      -> paisa per gram
 * Column names carry the unit so a wrong number cannot be read as the right kind of number.
 */

/** Three rows, ever: 'pkr', 'user_gold', 'platform_gold'. */
export const balances = pgTable(
  "balances",
  {
    key: text("key").primaryKey(),
    unit: text("unit").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("balances_key_valid", sql`${t.key} in ('pkr', 'user_gold', 'platform_gold')`),
    // 'pkr' is money; the other two are grams. The database refuses a mismatch,
    // so a paisa figure can never be written into a gram balance.
    check(
      "balances_unit_matches_key",
      sql`(${t.key} = 'pkr' and ${t.unit} = 'paisa') or (${t.key} <> 'pkr' and ${t.unit} = 'microgram')`,
    ),
    // An overdraft becomes a database error instead of a corrupt state.
    check("balances_non_negative", sql`${t.amount} >= 0`),
  ],
);

/**
 * One row per price lock. The status column is what makes "confirm twice"
 * settle once: the first confirm flips active -> settled, the second finds it
 * already flipped and returns the original receipt.
 */
export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    side: text("side").notNull(),
    status: text("status").notNull().default("active"),
    inputMode: text("input_mode").notNull(),
    inputMinor: bigint("input_minor", { mode: "bigint" }).notNull(),
    marketPaisaPerGram: bigint("market_paisa_per_gram", { mode: "bigint" }).notNull(),
    unitPaisaPerGram: bigint("unit_paisa_per_gram", { mode: "bigint" }).notNull(),
    spreadBps: integer("spread_bps").notNull(),
    goldMicrograms: bigint("gold_micrograms", { mode: "bigint" }).notNull(),
    pkrPaisa: bigint("pkr_paisa", { mode: "bigint" }).notNull(),
    guardrailPaisaPerGram: bigint("guardrail_paisa_per_gram", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    guardrailApplied: boolean("guardrail_applied").notNull().default(false),
    priceSource: text("price_source").notNull(),
    priceCycleId: uuid("price_cycle_id"),
    priceFetchedAt: timestamp("price_fetched_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    /** Set when a confirm fails validation (§5.2): the terminal state the UI diagnoses from. */
    rejectionReason: text("rejection_reason"),
  },
  (t) => [
    check("quotes_side_valid", sql`${t.side} in ('buy', 'sell')`),
    check(
      "quotes_status_valid",
      sql`${t.status} in ('active', 'settled', 'expired', 'cancelled', 'rejected')`,
    ),
    check("quotes_input_mode_valid", sql`${t.inputMode} in ('pkr', 'gold')`),
    check("quotes_amounts_positive", sql`${t.pkrPaisa} > 0 and ${t.goldMicrograms} > 0`),
    check("quotes_expiry_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    index("quotes_status_expiry_idx").on(t.status, t.expiresAt),
  ],
);

/**
 * One row per completed trade. This is the receipt; it is never edited.
 * The CHECK re-derives the price from the grams in integer SQL, so a receipt
 * whose arithmetic is wrong cannot be stored at all.
 */
export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quoteId: uuid("quote_id")
      .notNull()
      .unique()
      .references(() => quotes.id),
    side: text("side").notNull(),
    goldMicrograms: bigint("gold_micrograms", { mode: "bigint" }).notNull(),
    pkrPaisa: bigint("pkr_paisa", { mode: "bigint" }).notNull(),
    marketPaisaPerGram: bigint("market_paisa_per_gram", { mode: "bigint" }).notNull(),
    unitPaisaPerGram: bigint("unit_paisa_per_gram", { mode: "bigint" }).notNull(),
    spreadBps: integer("spread_bps").notNull(),
    guardrailPaisaPerGram: bigint("guardrail_paisa_per_gram", { mode: "bigint" }).notNull(),
    guardrailApplied: boolean("guardrail_applied").notNull(),
    priceSource: text("price_source").notNull(),
    priceFetchedAt: timestamp("price_fetched_at", { withTimezone: true }).notNull(),
    quoteCreatedAt: timestamp("quote_created_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("trades_side_valid", sql`${t.side} in ('buy', 'sell')`),
    check("trades_amounts_positive", sql`${t.pkrPaisa} > 0 and ${t.goldMicrograms} > 0`),
    // buy rounds the charge up, sell rounds the payout down: exactly the rule
    // applied when the quote was built, re-checked here in integer SQL.
    check(
      "trades_pkr_is_exact",
      sql`${t.pkrPaisa} = case when ${t.side} = 'buy'
            then (${t.goldMicrograms} * ${t.unitPaisaPerGram} + 999999) / 1000000
            else (${t.goldMicrograms} * ${t.unitPaisaPerGram}) / 1000000
          end`,
    ),
    index("trades_settled_at_idx").on(t.settledAt),
  ],
);

/**
 * One row per source per fetch cycle, so the screen can show what each source
 * said and why the losers were ignored. cycle_id groups the sources that were
 * fetched together; `selected` marks the one whose price the app used.
 */
export const prices = pgTable(
  "prices",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    cycleId: uuid("cycle_id").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").notNull(),
    pricePaisaPerGram: bigint("price_paisa_per_gram", { mode: "bigint" }),
    accepted: boolean("accepted").notNull().default(false),
    selected: boolean("selected").notNull().default(false),
    reason: text("reason"),
  },
  (t) => [
    check("prices_source_valid", sql`${t.source} in ('A_pakgold', 'B_goldprice', 'C_yahoo')`),
    index("prices_cycle_idx").on(t.cycleId),
    index("prices_fetched_at_idx").on(t.fetchedAt),
  ],
);

/** Single row. Everything the evaluator can change without a redeploy. */
export const settings = pgTable(
  "settings",
  {
    id: boolean("id").primaryKey().default(true),
    guardrailPaisaPerGram: bigint("guardrail_paisa_per_gram", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    quoteTtlSeconds: integer("quote_ttl_seconds").notNull().default(75),
    divergenceThresholdBps: integer("divergence_threshold_bps").notNull().default(100),
    maxPriceAgeSeconds: integer("max_price_age_seconds").notNull().default(600),
    sourceAOn: boolean("source_a_on").notNull().default(true),
    sourceBOn: boolean("source_b_on").notNull().default(true),
    sourceCOn: boolean("source_c_on").notNull().default(true),
    priceOverridePaisa: bigint("price_override_paisa", { mode: "bigint" }),
    /** §6.1.1: GC=F is futures. This measured basis turns it into a spot-equivalent. */
    sourceCBasisBps: integer("source_c_basis_bps").notNull().default(28),
    forcePaused: boolean("force_paused").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("settings_singleton", sql`${t.id}`),
    // The basis is a small measured offset, not a dial to cheat the quorum with.
    check("settings_basis_range", sql`${t.sourceCBasisBps} between -500 and 500`)],
);
