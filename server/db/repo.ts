import { MICRO } from '../../domain/units';
import { ceilDiv, type Side } from '../../domain/trade-math';
import type { SourceId } from '../../domain/quorum';
import { AppError } from '../http';
import { getPool, withTx } from './index';
import { SEED_BALANCES } from './seed-values';

type Runner = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
};

export interface Balances {
  pkrPaisa: bigint;
  userGoldMicrograms: bigint;
  platformGoldMicrograms: bigint;
}

export interface SettingsRow {
  id: boolean;
  guardrailPaisaPerGram: bigint;
  quoteTtlSeconds: number;
  divergenceThresholdBps: number;
  maxPriceAgeSeconds: number;
  priceFetchIntervalSeconds: number;
  sourceAOn: boolean;
  sourceBOn: boolean;
  sourceCOn: boolean;
  sourceCBasisBps: number;
  priceOverridePaisa: bigint | null;
  forcePaused: boolean;
  updatedAt: Date;
}

export interface QuoteRow {
  id: string;
  side: Side;
  status: 'active' | 'confirmed' | 'settled' | 'expired' | 'cancelled' | 'rejected';
  inputMode: 'pkr' | 'grams';
  inputMinor: bigint;
  marketPaisaPerGram: bigint;
  unitPaisaPerGram: bigint;
  spreadBps: number;
  goldMicrograms: bigint;
  pkrPaisa: bigint;
  guardrailPaisaPerGram: bigint;
  guardrailApplied: boolean;
  priceSource: SourceId;
  priceCycleId: string | null;
  priceFetchedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  settledAt: Date | null;
  rejectionReason: string | null;
  isDue?: boolean;
}

export interface TradeRow {
  id: string;
  quoteId: string;
  side: Side;
  goldMicrograms: bigint;
  pkrPaisa: bigint;
  marketPaisaPerGram: bigint;
  unitPaisaPerGram: bigint;
  spreadBps: number;
  guardrailPaisaPerGram: bigint;
  guardrailApplied: boolean;
  priceSource: SourceId;
  priceFetchedAt: Date;
  quoteCreatedAt: Date;
  settledAt: Date;
}

export interface PriceRow {
  id: number;
  cycleId: string;
  fetchedAt: Date;
  source: SourceId;
  pricePaisaPerGram: bigint | null;
  accepted: boolean;
  selected: boolean;
  reason: string;
}

function big(value: unknown): bigint {
  return BigInt(String(value));
}

function mapBalances(rows: any[]): Balances {
  const map = new Map<string, bigint>();
  for (const row of rows) map.set(row.key, big(row.amount));
  const pkr = map.get('pkr');
  const user = map.get('user_gold');
  const platform = map.get('platform_gold');
  if (pkr === undefined || user === undefined || platform === undefined) {
    throw new AppError(
      'INTERNAL',
      'Balances are not seeded. Run npm run db:seed.',
    );
  }
  return {
    pkrPaisa: pkr,
    userGoldMicrograms: user,
    platformGoldMicrograms: platform,
  };
}

function mapSettings(row: any): SettingsRow {
  return {
    id: row.id,
    guardrailPaisaPerGram: big(row.guardrail_paisa_per_gram),
    quoteTtlSeconds: Number(row.quote_ttl_seconds),
    divergenceThresholdBps: Number(row.divergence_threshold_bps),
    maxPriceAgeSeconds: Number(row.max_price_age_seconds),
    priceFetchIntervalSeconds: Number(row.price_fetch_interval_seconds),
    sourceAOn: row.source_a_on,
    sourceBOn: row.source_b_on,
    sourceCOn: row.source_c_on,
    sourceCBasisBps: Number(row.source_c_basis_bps),
    priceOverridePaisa:
      row.price_override_paisa === null ? null : big(row.price_override_paisa),
    forcePaused: row.force_paused,
    updatedAt: new Date(row.updated_at),
  };
}

function mapQuote(row: any): QuoteRow {
  return {
    id: row.id,
    side: row.side,
    status: row.status,
    inputMode: row.input_mode,
    inputMinor: big(row.input_minor),
    marketPaisaPerGram: big(row.market_paisa_per_gram),
    unitPaisaPerGram: big(row.unit_paisa_per_gram),
    spreadBps: Number(row.spread_bps),
    goldMicrograms: big(row.gold_micrograms),
    pkrPaisa: big(row.pkr_paisa),
    guardrailPaisaPerGram: big(row.guardrail_paisa_per_gram),
    guardrailApplied: row.guardrail_applied,
    priceSource: row.price_source,
    priceCycleId: row.price_cycle_id,
    priceFetchedAt: new Date(row.price_fetched_at),
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    settledAt: row.settled_at ? new Date(row.settled_at) : null,
    rejectionReason: row.rejection_reason,
    ...(row.is_due !== undefined ? { isDue: row.is_due } : {}),
  };
}

function mapTrade(row: any): TradeRow {
  return {
    id: row.id,
    quoteId: row.quote_id,
    side: row.side,
    goldMicrograms: big(row.gold_micrograms),
    pkrPaisa: big(row.pkr_paisa),
    marketPaisaPerGram: big(row.market_paisa_per_gram),
    unitPaisaPerGram: big(row.unit_paisa_per_gram),
    spreadBps: Number(row.spread_bps),
    guardrailPaisaPerGram: big(row.guardrail_paisa_per_gram),
    guardrailApplied: row.guardrail_applied,
    priceSource: row.price_source,
    priceFetchedAt: new Date(row.price_fetched_at),
    quoteCreatedAt: new Date(row.quote_created_at),
    settledAt: new Date(row.settled_at),
  };
}

export function mapPrice(row: any): PriceRow {
  return {
    id: Number(row.id),
    cycleId: row.cycle_id,
    fetchedAt: new Date(row.fetched_at),
    source: row.source,
    pricePaisaPerGram:
      row.price_paisa_per_gram === null ? null : big(row.price_paisa_per_gram),
    accepted: row.accepted,
    selected: row.selected,
    reason: row.reason,
  };
}

export async function getSettings(client?: Runner): Promise<SettingsRow> {
  const runner = client ?? getPool();
  let result = await runner.query('select * from settings where id = true');
  if (result.rows.length === 0) {
    await runner.query(
      'insert into settings (id) values (true) on conflict (id) do nothing',
    );
    result = await runner.query('select * from settings where id = true');
  }
  return mapSettings(result.rows[0]);
}

export type SettingsPatch = Partial<
  Omit<SettingsRow, 'id' | 'updatedAt'>
>;

const SETTINGS_COLUMNS: Record<keyof SettingsPatch, string> = {
  guardrailPaisaPerGram: 'guardrail_paisa_per_gram',
  quoteTtlSeconds: 'quote_ttl_seconds',
  divergenceThresholdBps: 'divergence_threshold_bps',
  maxPriceAgeSeconds: 'max_price_age_seconds',
  priceFetchIntervalSeconds: 'price_fetch_interval_seconds',
  sourceAOn: 'source_a_on',
  sourceBOn: 'source_b_on',
  sourceCOn: 'source_c_on',
  sourceCBasisBps: 'source_c_basis_bps',
  priceOverridePaisa: 'price_override_paisa',
  forcePaused: 'force_paused',
};

export async function updateSettings(patch: SettingsPatch): Promise<SettingsRow> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return getSettings();

  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;
  for (const [key, value] of entries) {
    const column = SETTINGS_COLUMNS[key as keyof SettingsPatch];
    if (!column) throw new AppError('BAD_REQUEST', `Unknown setting ${key}.`);
    sets.push(`${column} = $${index}`);
    values.push(typeof value === 'bigint' ? value.toString() : value);
    index += 1;
  }
  sets.push('updated_at = now()');

  const result = await getPool().query(
    `update settings set ${sets.join(', ')} where id = true returning *`,
    values,
  );
  return mapSettings(result.rows[0]);
}

export async function getBalances(client?: Runner): Promise<Balances> {
  const runner = client ?? getPool();
  const result = await runner.query(
    `select key, amount from balances
      where key in ('pkr', 'user_gold', 'platform_gold')`,
  );
  return mapBalances(result.rows);
}

export interface NewQuoteInput {
  side: Side;
  inputMode: 'pkr' | 'grams';
  inputMinor: bigint;
  marketPaisaPerGram: bigint;
  unitPaisaPerGram: bigint;
  spreadBps: number;
  goldMicrograms: bigint;
  pkrPaisa: bigint;
  guardrailPaisaPerGram: bigint;
  guardrailApplied: boolean;
  priceSource: SourceId;
  priceCycleId: string | null;
  priceFetchedAt: Date;
  ttlSeconds: number;
}

export async function insertQuote(input: NewQuoteInput): Promise<QuoteRow> {
  const result = await getPool().query(
    `insert into quotes (
        side, status, input_mode, input_minor, market_paisa_per_gram,
        unit_paisa_per_gram, spread_bps, gold_micrograms, pkr_paisa,
        guardrail_paisa_per_gram, guardrail_applied, price_source,
        price_cycle_id, price_fetched_at, expires_at
     ) values (
        $1, 'active', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        now() + make_interval(secs => $14::double precision)
     ) returning *`,
    [
      input.side,
      input.inputMode,
      input.inputMinor.toString(),
      input.marketPaisaPerGram.toString(),
      input.unitPaisaPerGram.toString(),
      input.spreadBps,
      input.goldMicrograms.toString(),
      input.pkrPaisa.toString(),
      input.guardrailPaisaPerGram.toString(),
      input.guardrailApplied,
      input.priceSource,
      input.priceCycleId,
      input.priceFetchedAt.toISOString(),
      input.ttlSeconds,
    ],
  );
  return mapQuote(result.rows[0]);
}

export async function getQuote(id: string, client?: Runner): Promise<QuoteRow | null> {
  const runner = client ?? getPool();
  const result = await runner.query(
    `select *, (expires_at <= now()) as is_due from quotes where id = $1`,
    [id],
  );
  return result.rows.length === 0 ? null : mapQuote(result.rows[0]);
}

export async function getLiveQuote(): Promise<QuoteRow | null> {
  const result = await getPool().query(
    `select *, (expires_at <= now()) as is_due from quotes
      where status in ('active', 'confirmed')
      order by created_at desc
      limit 1`,
  );
  return result.rows.length === 0 ? null : mapQuote(result.rows[0]);
}

export async function getQuoteByIdempotent(
  id: string,
): Promise<{ quote: QuoteRow; trade: TradeRow | null } | null> {
  const quote = await getQuote(id);
  if (!quote) return null;
  const trade = quote.status === 'settled' ? await getTradeByQuoteId(id) : null;
  return { quote, trade };
}

export async function confirmQuoteRow(id: string): Promise<QuoteRow | null> {
  // The countdown is a review hold, not the quote's lifetime. Confirming is
  // only allowed once that hold has finished; the row stays active until then.
  const result = await getPool().query(
    `update quotes set status = 'confirmed'
      where id = $1 and status = 'active' and expires_at <= now()
      returning *, (expires_at <= now()) as is_due`,
    [id],
  );
  return result.rows.length === 0 ? null : mapQuote(result.rows[0]);
}

export async function cancelQuoteRow(
  id: string,
): Promise<{ id: string; status: 'cancelled' } | null> {
  // An active quote can be cancelled for as long as it exists (including after
  // the countdown). A staged confirmed quote can only be cancelled early.
  const result = await getPool().query(
    `update quotes set status = 'cancelled'
      where id = $1 and (
        status = 'active'
        or (status = 'confirmed' and expires_at > now())
      )
      returning id, status`,
    [id],
  );
  return result.rows.length === 0
    ? null
    : { id: result.rows[0].id, status: 'cancelled' };
}

export async function getTradeByQuoteId(
  quoteId: string,
  client?: Runner,
): Promise<TradeRow | null> {
  const runner = client ?? getPool();
  const result = await runner.query('select * from trades where quote_id = $1', [
    quoteId,
  ]);
  return result.rows.length === 0 ? null : mapTrade(result.rows[0]);
}

export async function getTradeById(id: string): Promise<TradeRow | null> {
  const result = await getPool().query('select * from trades where id = $1', [id]);
  return result.rows.length === 0 ? null : mapTrade(result.rows[0]);
}

export async function listTrades(limit = 10): Promise<TradeRow[]> {
  const result = await getPool().query(
    `select * from trades order by settled_at desc, id desc limit $1`,
    [limit],
  );
  return result.rows.map(mapTrade);
}

export async function listTradesAtOrAfter(settledAt: Date): Promise<TradeRow[]> {
  const result = await getPool().query(
    `select * from trades
      where settled_at >= $1
      order by settled_at desc, id desc`,
    [settledAt.toISOString()],
  );
  return result.rows.map(mapTrade);
}

export async function listQuotes(limit = 25): Promise<QuoteRow[]> {
  const result = await getPool().query(
    `select * from quotes order by created_at desc limit $1`,
    [limit],
  );
  return result.rows.map(mapQuote);
}

export async function listPrices(limit = 30): Promise<PriceRow[]> {
  const result = await getPool().query(
    `select * from prices order by fetched_at desc, id desc limit $1`,
    [limit],
  );
  return result.rows.map(mapPrice);
}

/** One published point per cycle, oldest first, for the price chart. */
export async function listSelectedPrices(limit = 80): Promise<PriceRow[]> {
  const result = await getPool().query(
    `select * from prices
      where selected = true
      order by fetched_at desc, id desc
      limit $1`,
    [limit],
  );
  return result.rows.map(mapPrice).reverse();
}

export async function getAnchorPaisaPerGram(): Promise<bigint | null> {
  const result = await getPool().query(
    `select price_paisa_per_gram from prices
      where selected = true and price_paisa_per_gram is not null
      order by fetched_at desc, id desc
      limit 1`,
  );
  return result.rows.length === 0
    ? null
    : big(result.rows[0].price_paisa_per_gram);
}

export interface PriceInsert {
  source: SourceId;
  pricePaisaPerGram: bigint | null;
  accepted: boolean;
  selected: boolean;
  reason: string;
}

export async function insertPriceRows(
  cycleId: string,
  fetchedAt: Date,
  rows: PriceInsert[],
): Promise<void> {
  if (rows.length === 0) return;
  await withTx(async (client) => {
    for (const row of rows) {
      await client.query(
        `insert into prices (
           cycle_id, fetched_at, source, price_paisa_per_gram,
           accepted, selected, reason
         ) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (cycle_id, source) do nothing`,
        [
          cycleId,
          fetchedAt.toISOString(),
          row.source,
          row.pricePaisaPerGram === null ? null : row.pricePaisaPerGram.toString(),
          row.accepted,
          row.selected,
          row.reason,
        ],
      );
    }
  });
}

/** Newest cycle only, used to rebuild a snapshot after a cache miss. */
export async function selectLatestCyclePrices(): Promise<PriceRow[]> {
  const result = await getPool().query(
    `select * from prices
      where cycle_id = (
        select cycle_id from prices order by fetched_at desc, id desc limit 1
      )
      order by source`,
  );
  return result.rows.map(mapPrice);
}

export async function setBalance(
  key: 'pkr' | 'user_gold' | 'platform_gold',
  amount: bigint,
): Promise<Balances> {
  const unit = key === 'pkr' ? 'paisa' : 'microgram';
  await getPool().query(
    `insert into balances (key, unit, amount, updated_at)
     values ($1, $2, $3, now())
     on conflict (key) do update set amount = excluded.amount, updated_at = now()`,
    [key, unit, amount.toString()],
  );
  return getBalances();
}

export async function resetDemo(): Promise<Balances> {
  await withTx(async (client) => {
    await client.query('delete from trades');
    await client.query('delete from quotes');
    for (const balance of SEED_BALANCES) {
      await client.query(
        `insert into balances (key, unit, amount, updated_at)
         values ($1, $2, $3, now())
         on conflict (key) do update set amount = excluded.amount, updated_at = now()`,
        [balance.key, balance.unit, balance.amount.toString()],
      );
    }
  });
  return getBalances();
}

export type SettleOutcome =
  | { kind: 'settled'; trade: TradeRow; replayed: boolean }
  | { kind: 'pending' }
  | { kind: 'shortfall'; error: AppError };

function quoteStatusError(quote: QuoteRow): AppError {
  switch (quote.status) {
    case 'expired':
      return new AppError(
        'QUOTE_EXPIRED',
        'This quote has expired. Request a new price.',
      );
    case 'cancelled':
      return new AppError('QUOTE_CANCELLED', 'This quote was cancelled.');
    case 'rejected':
      return new AppError(
        'QUOTE_REJECTED',
        'This quote was rejected because a balance was no longer sufficient.',
        quote.rejectionReason ?? undefined,
      );
    case 'settled':
      return new AppError('QUOTE_SETTLED', 'This quote has already settled.');
    default:
      return new AppError('QUOTE_EXPIRED', 'This quote can no longer settle.');
  }
}

function affordableDetail(quote: QuoteRow, balances: Balances) {
  const price = quote.unitPaisaPerGram;
  if (quote.side === 'buy') {
    return {
      max_pkr_paisa: (
        balances.pkrPaisa < ceilDiv(balances.platformGoldMicrograms * price, MICRO)
          ? balances.pkrPaisa
          : ceilDiv(balances.platformGoldMicrograms * price, MICRO)
      ).toString(),
      max_gold_micrograms: (
        (balances.pkrPaisa * MICRO) / price < balances.platformGoldMicrograms
          ? (balances.pkrPaisa * MICRO) / price
          : balances.platformGoldMicrograms
      ).toString(),
    };
  }
  return {
    max_gold_micrograms: balances.userGoldMicrograms.toString(),
    max_pkr_paisa: ((balances.userGoldMicrograms * price) / MICRO).toString(),
  };
}

/**
 * Claim -> lock -> re-validate -> apply deltas -> insert trade, all in one
 * transaction. Conditional claim makes settlement exactly-once; the trade's
 * unique quote_id is the second line of defence.
 */
export async function settleQuote(id: string): Promise<SettleOutcome> {
  return withTx(async (client) => {
    const claim = await client.query(
      `update quotes set status = 'settled', settled_at = now()
        where id = $1 and status = 'confirmed' and expires_at <= now()
        returning *`,
      [id],
    );

    if ((claim.rowCount ?? 0) === 0) {
      const quote = await getQuote(id, client);
      if (!quote) throw new AppError('NOT_FOUND', 'Quote not found.');

      if (quote.status === 'settled') {
        const trade = await getTradeByQuoteId(id, client);
        if (!trade) {
          throw new AppError('INTERNAL', 'Settled quote has no trade record.');
        }
        return { kind: 'settled', trade, replayed: true };
      }
      if (quote.status === 'confirmed') return { kind: 'pending' };
      if (quote.status === 'active') {
        throw new AppError(
          'QUOTE_NOT_READY',
          'The quote is still counting down. Confirm it when the timer reaches zero.',
        );
      }
      throw quoteStatusError(quote);
    }

    const quote = mapQuote(claim.rows[0]);

    const locked = await client.query(
      `select key, amount from balances
        where key in ('pkr', 'user_gold', 'platform_gold')
        order by key
        for update`,
    );
    const balances = mapBalances(locked.rows);

    let shortfall: AppError | null = null;
    if (quote.side === 'buy') {
      if (balances.pkrPaisa < quote.pkrPaisa) {
        shortfall = new AppError(
          'INSUFFICIENT_PKR',
          'Your PKR balance is no longer enough for this quote.',
          'The quote was rejected. Create a new quote for the amount you can afford.',
          affordableDetail(quote, balances),
        );
      } else if (balances.platformGoldMicrograms < quote.goldMicrograms) {
        shortfall = new AppError(
          'INSUFFICIENT_INVENTORY',
          'The platform inventory is no longer enough for this quote.',
          'The quote was rejected. Create a new quote for the amount available.',
          affordableDetail(quote, balances),
        );
      }
    } else if (balances.userGoldMicrograms < quote.goldMicrograms) {
      shortfall = new AppError(
        'INSUFFICIENT_GOLD',
        'Your gold balance is no longer enough for this quote.',
        'The quote was rejected. Create a new quote for the amount you hold.',
        affordableDetail(quote, balances),
      );
    }

    if (shortfall) {
      await client.query(
        `update quotes
            set status = 'rejected', settled_at = null, rejection_reason = $2
          where id = $1`,
        [id, shortfall.code],
      );
      return { kind: 'shortfall', error: shortfall };
    }

    const deltas =
      quote.side === 'buy'
        ? [
            { key: 'pkr', sign: -1n },
            { key: 'user_gold', sign: 1n },
            { key: 'platform_gold', sign: -1n },
          ]
        : [
            { key: 'pkr', sign: 1n },
            { key: 'user_gold', sign: -1n },
            { key: 'platform_gold', sign: 1n },
          ];

    for (const delta of deltas) {
      const amount =
        delta.key === 'pkr' ? quote.pkrPaisa : quote.goldMicrograms;
      const result = await client.query(
        `update balances
            set amount = amount + $2, updated_at = now()
          where key = $1 and amount + $2 >= 0`,
        [delta.key, (delta.sign * amount).toString()],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new AppError('INTERNAL', 'Balance update would go negative.');
      }
    }

    const trade = await client.query(
      `insert into trades (
          quote_id, side, gold_micrograms, pkr_paisa, market_paisa_per_gram,
          unit_paisa_per_gram, spread_bps, guardrail_paisa_per_gram,
          guardrail_applied, price_source, price_fetched_at, quote_created_at,
          settled_at
       ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now()
       ) returning *`,
      [
        quote.id,
        quote.side,
        quote.goldMicrograms.toString(),
        quote.pkrPaisa.toString(),
        quote.marketPaisaPerGram.toString(),
        quote.unitPaisaPerGram.toString(),
        quote.spreadBps,
        quote.guardrailPaisaPerGram.toString(),
        quote.guardrailApplied,
        quote.priceSource,
        quote.priceFetchedAt.toISOString(),
        quote.createdAt.toISOString(),
      ],
    );

    return { kind: 'settled', trade: mapTrade(trade.rows[0]), replayed: false };
  });
}

export interface SweepResult {
  expired: number;
  settled: number;
  rejected: number;
}

export async function sweepQuotes(): Promise<SweepResult> {
  // Active quotes are deliberately not expired here: the countdown only locks
  // the confirmation button. The user must cancel or confirm.
  const due = await getPool().query(
    `select id from quotes
      where status = 'confirmed' and expires_at <= now()
      order by expires_at
      limit 50`,
  );

  let settled = 0;
  let rejected = 0;
  for (const row of due.rows) {
    try {
      const outcome = await settleQuote(row.id);
      if (outcome.kind === 'settled' && !outcome.replayed) settled += 1;
      if (outcome.kind === 'shortfall') rejected += 1;
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === 'INSUFFICIENT_PKR' ||
            error.code === 'INSUFFICIENT_GOLD' ||
            error.code === 'INSUFFICIENT_INVENTORY') {
          rejected += 1;
        } else if (
          error.code === 'QUOTE_EXPIRED' ||
          error.code === 'QUOTE_CANCELLED' ||
          error.code === 'QUOTE_REJECTED'
        ) {
          // Already terminal (e.g. a concurrent sweep rejected it); nothing to do.
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  return {
    expired: 0,
    settled,
    rejected,
  };
}

