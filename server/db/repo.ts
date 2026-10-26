import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, runInTransaction, type Tx } from "./index";
import { balances, prices, quotes, settings, trades } from "./schema";
import type { QuoteTerms } from "../../domain/trade-math";
import type { ErrorCode } from "../http";

export type BalanceKey = "pkr" | "user_gold" | "platform_gold";
export type QuoteRow = typeof quotes.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;

export interface BalanceSnapshot {
  pkrPaisa: bigint;
  userGoldMicrograms: bigint;
  platformGoldMicrograms: bigint;
}

/* ------------------------------------------------------------------ */
/* Settings — demo config lives in the database, never in env          */
/* ------------------------------------------------------------------ */

/** Read the singleton settings, creating it when the DB is fresh. */
export async function getSettings(): Promise<typeof settings.$inferSelect> {
  const existing = await db.select().from(settings).limit(1);
  if (existing[0]) return existing[0];
  await db.insert(settings).values({}).onConflictDoNothing();
  const created = await db.select().from(settings).limit(1);
  const row = created[0];
  if (!row) throw new Error("settings row missing after insert");
  return row;
}

export async function updateSettings(patch: Partial<typeof settings.$inferInsert>): Promise<void> {
  await getSettings(); // ensure the row exists first
  await db
    .update(settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settings.id, true));
}

/* ------------------------------------------------------------------ */
/* Balances                                                            */
/* ------------------------------------------------------------------ */

function snapshotOf(rows: Array<{ key: string; amount: bigint }>): BalanceSnapshot {
  let pkrPaisa = 0n;
  let userGoldMicrograms = 0n;
  let platformGoldMicrograms = 0n;
  for (const row of rows) {
    if (row.key === "pkr") pkrPaisa = row.amount;
    else if (row.key === "user_gold") userGoldMicrograms = row.amount;
    else if (row.key === "platform_gold") platformGoldMicrograms = row.amount;
  }
  return { pkrPaisa, userGoldMicrograms, platformGoldMicrograms };
}

export async function getBalances(): Promise<BalanceSnapshot> {
  const rows = await db.select({ key: balances.key, amount: balances.amount }).from(balances);
  return snapshotOf(rows);
}

async function readBalances(tx: Tx): Promise<BalanceSnapshot> {
  // §5.1 step 2: balances are re-read FOR UPDATE so validation and the
  // deltas observe exactly the same state, even if a demo control just moved them.
  const rows = await tx.select({ key: balances.key, amount: balances.amount }).from(balances).for("update");
  return snapshotOf(rows);
}

export async function setBalance(key: BalanceKey, amount: bigint): Promise<void> {
  await db
    .update(balances)
    .set({ amount, updatedAt: new Date() })
    .where(eq(balances.key, key));
}

export const DEMO_SEED: BalanceSnapshot = {
  pkrPaisa: 50_000_000n, // Rs 500,000.00
  userGoldMicrograms: 20_000_000n, // 20 g
  platformGoldMicrograms: 100_000_000n, // 100 g — 120 g total, forever
};

export async function resetDemo(): Promise<void> {
  await runInTransaction(async (tx) => {
    await tx.delete(trades);
    const idRows = await tx.select({ id: quotes.id }).from(quotes);
    if (idRows.length > 0) {
      await tx.delete(quotes).where(inArray(quotes.id, idRows.map((r) => r.id)));
    }
    await tx
      .insert(balances)
      .values([
        { key: "pkr", unit: "paisa", amount: DEMO_SEED.pkrPaisa },
        { key: "user_gold", unit: "microgram", amount: DEMO_SEED.userGoldMicrograms },
        { key: "platform_gold", unit: "microgram", amount: DEMO_SEED.platformGoldMicrograms },
      ])
      .onConflictDoUpdate({
        target: balances.key,
        set: { amount: sql`excluded."amount"`, updatedAt: new Date() },
      });
  });
}

/* ------------------------------------------------------------------ */
/* Price records                                                       */
/* ------------------------------------------------------------------ */

export async function getLatestCycleSamples(limit = 30): Promise<Array<typeof prices.$inferSelect>> {
  return db.select().from(prices).orderBy(desc(prices.fetchedAt), prices.source).limit(limit);
}

/* ------------------------------------------------------------------ */
/* Quotes and trades                                                   */
/* ------------------------------------------------------------------ */

export async function insertQuoteTerms(
  terms: QuoteTerms,
  opts: { expiresAt: Date; priceCycleId: string | null; priceFetchedAtSeconds: number; priceSource: string },
): Promise<QuoteRow> {
  const rows = await db
    .insert(quotes)
    .values({
      side: terms.side,
      status: "active",
      inputMode: terms.inputMode,
      inputMinor: terms.inputMinor,
      marketPaisaPerGram: terms.marketPaisaPerGram,
      unitPaisaPerGram: terms.unitPaisaPerGram,
      spreadBps: terms.spreadBps,
      goldMicrograms: terms.goldMicrograms,
      pkrPaisa: terms.pkrPaisa,
      guardrailPaisaPerGram: terms.guardrailPaisaPerGram,
      guardrailApplied: terms.guardrailApplied,
      priceSource: opts.priceSource,
      priceCycleId: opts.priceCycleId,
      priceFetchedAt: new Date(opts.priceFetchedAtSeconds * 1000),
      expiresAt: opts.expiresAt,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("quote insert failed to return a row");
  return row;
}

export async function getQuote(id: string): Promise<QuoteRow | null> {
  const rows = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getTrade(id: string): Promise<TradeRow | null> {
  const rows = await db.select().from(trades).where(eq(trades.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getTradeByQuoteId(quoteId: string): Promise<TradeRow | null> {
  const rows = await db.select().from(trades).where(eq(trades.quoteId, quoteId)).limit(1);
  return rows[0] ?? null;
}

export async function getRecentTrades(limit = 10): Promise<TradeRow[]> {
  return db.select().from(trades).orderBy(desc(trades.settledAt)).limit(limit);
}

/* ------------------------------------------------------------------ */
/* Exactly-once settlement (§5.1, §5.2)                                */
/* ------------------------------------------------------------------ */

export type SettleResult =
  | { outcome: "settled"; trade: TradeRow; balancesBefore: BalanceSnapshot; balancesAfter: BalanceSnapshot }
  | { outcome: "replayed"; trade: TradeRow; balancesAfter: BalanceSnapshot }
  | { outcome: "quoteGone" }
  | { outcome: "expired"; quote: QuoteRow }
  | { outcome: "cancelled"; quote: QuoteRow }
  | { outcome: "rejected"; quote: QuoteRow }
  | { outcome: "shortfall"; code: ErrorCode; message: string; maxAffordableMinor: bigint; maxAffordableUnit: string; quote: QuoteRow };

export async function settleQuote(quoteId: string): Promise<SettleResult> {
  return runInTransaction(async (tx) => {
    // 1. claim the quote — this conditional UPDATE *is* the idempotency check.
    const claimed = await tx
      .update(quotes)
      .set({ status: "settled", settledAt: new Date() })
      .where(and(eq(quotes.id, quoteId), eq(quotes.status, "active"), gt(quotes.expiresAt, new Date())))
      .returning();

    const quote = claimed[0];
    if (!quote) {
      // 0 rows -> touch no balances; diagnose from the committed state (§5.2).
      const found = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
      const row = found[0];
      if (!row) return { outcome: "quoteGone" };

      if (row.status === "settled") {
        const tradeRows = await tx.select().from(trades).where(eq(trades.quoteId, quoteId)).limit(1);
        const trade = tradeRows[0];
        if (trade) return { outcome: "replayed", trade, balancesAfter: await readBalances(tx) };
        // settled without a trade exists: demo reset raced; treat as gone.
        return { outcome: "quoteGone" };
      }
      if (row.status === "active" && row.expiresAt.getTime() <= Date.now()) {
        // Opportunistically persist the derived state; no cron sweeps quotes.
        await tx.update(quotes).set({ status: "expired" }).where(eq(quotes.id, quoteId));
        return { outcome: "expired", quote: row };
      }
      if (row.status === "cancelled") return { outcome: "cancelled", quote: row };
      if (row.status === "rejected") return { outcome: "rejected", quote: row };
      return { outcome: "expired", quote: row };
    }

    const balancesBefore = await readBalances(tx);
    const g = quote.goldMicrograms;
    const a = quote.pkrPaisa;

    // 2. re-validate against *current* balances — quotes hold nothing (§4).
    if (quote.side === "buy") {
      if (balancesBefore.pkrPaisa < a) {
        await rejectInsideTx(tx, quote.id, "INSUFFICIENT_PKR");
        // Most they could buy at this quote's locked price: floor(wallet x 1e6 / unit).
        const maxGrams = (balancesBefore.pkrPaisa * 1_000_000n) / quote.unitPaisaPerGram;
        return {
          outcome: "shortfall",
          code: "INSUFFICIENT_PKR",
          message: "Your PKR wallet is below the trade amount (balances may have moved since the quote).",
          maxAffordableMinor: maxGrams,
          maxAffordableUnit: "microgram",
          quote,
        };
      }
      if (balancesBefore.platformGoldMicrograms < g) {
        await rejectInsideTx(tx, quote.id, "INSUFFICIENT_INVENTORY");
        return {
          outcome: "shortfall",
          code: "INSUFFICIENT_INVENTORY",
          message: `Only ${Number(balancesBefore.platformGoldMicrograms) / 1e6} g remain in inventory.`,
          maxAffordableMinor: balancesBefore.platformGoldMicrograms,
          maxAffordableUnit: "microgram",
          quote,
        };
      }
    } else if (balancesBefore.userGoldMicrograms < g) {
      await rejectInsideTx(tx, quote.id, "INSUFFICIENT_GOLD");
      return {
        outcome: "shortfall",
        code: "INSUFFICIENT_GOLD",
        message: `You hold ${Number(balancesBefore.userGoldMicrograms) / 1e6} g but are selling ${Number(g) / 1e6} g.`,
        maxAffordableMinor: balancesBefore.userGoldMicrograms,
        maxAffordableUnit: "microgram",
        quote,
      };
    }

    // 3. apply the deltas; 4. write the append-only receipt.
    const now = new Date();
    const buy = quote.side === "buy";
    await tx
      .update(balances)
      .set({ amount: sql`${balances.amount} ${buy ? sql`-` : sql`+`} ${a}`, updatedAt: now })
      .where(eq(balances.key, "pkr"));
    await tx
      .update(balances)
      .set({ amount: sql`${balances.amount} ${buy ? sql`+` : sql`-`} ${g}`, updatedAt: now })
      .where(eq(balances.key, "user_gold"));
    await tx
      .update(balances)
      .set({ amount: sql`${balances.amount} ${buy ? sql`-` : sql`+`} ${g}`, updatedAt: now })
      .where(eq(balances.key, "platform_gold"));

    const tradeRows = await tx
      .insert(trades)
      .values({
        quoteId: quote.id,
        side: quote.side,
        goldMicrograms: g,
        pkrPaisa: a,
        marketPaisaPerGram: quote.marketPaisaPerGram,
        unitPaisaPerGram: quote.unitPaisaPerGram,
        spreadBps: quote.spreadBps,
        guardrailPaisaPerGram: quote.guardrailPaisaPerGram,
        guardrailApplied: quote.guardrailApplied,
        priceSource: quote.priceSource,
        priceFetchedAt: quote.priceFetchedAt,
        quoteCreatedAt: quote.createdAt,
        settledAt: now,
      })
      .returning();

    const trade = tradeRows[0];
    if (!trade) throw new Error("trade insert failed to return a row");

    const balancesAfter = await readBalances(tx);
    return { outcome: "settled", trade, balancesBefore, balancesAfter };
  });
}

/**
 * §5.2 diagnosis path: cancel a still-active quote. Idempotent; expired
 * quotes stay expired and settle receipts stay receipts.
 */
export type CancelResult =
  | { outcome: "cancelled"; quote: QuoteRow }
  | { outcome: "alreadyCancelled"; quote: QuoteRow }
  | { outcome: "settled"; quote: QuoteRow }
  | { outcome: "rejected"; quote: QuoteRow }
  | { outcome: "expired"; quote: QuoteRow }
  | { outcome: "quoteGone" };

export async function cancelQuote(quoteId: string): Promise<CancelResult> {
  return runInTransaction(async (tx) => {
    const cancelled = await tx
      .update(quotes)
      .set({ status: "cancelled" })
      .where(and(eq(quotes.id, quoteId), eq(quotes.status, "active"), gt(quotes.expiresAt, new Date())))
      .returning();

    const row = cancelled[0];
    if (row) return { outcome: "cancelled", quote: row };

    const found = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    const current = found[0];
    if (!current) return { outcome: "quoteGone" };

    if (current.status === "active" && current.expiresAt.getTime() <= Date.now()) {
      await tx.update(quotes).set({ status: "expired" }).where(eq(quotes.id, quoteId));
      return { outcome: "expired", quote: current };
    }
    if (current.status === "cancelled") return { outcome: "alreadyCancelled", quote: current };
    return { outcome: current.status === "settled" ? "settled" : current.status === "rejected" ? "rejected" : "expired", quote: current } satisfies CancelResult;
  });
}

async function rejectInsideTx(tx: Tx, quoteId: string, code: ErrorCode): Promise<void> {
  // The claim already flipped settled; validation failed, so the terminal
  // state a concurrent loser must diagnose from is `rejected`.
  await tx
    .update(quotes)
    .set({ status: "rejected", rejectionReason: code })
    .where(eq(quotes.id, quoteId));
}
