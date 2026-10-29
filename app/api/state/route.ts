import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../server/db";
import { quotes } from "../../../server/db/schema";
import {
  getBalances,
  getRecentTrades,
  getSettings,
  settleDueConfirmedQuotes,
  type BalanceSnapshot,
} from "../../../server/db/repo";
import { getPrice, tradingGate } from "../../../server/pricing/price";
import { balancesWire, priceWire, quoteWire, settingsWire, tradeWire } from "../../../server/serialize";
import { tryPreflight, withCors } from "../../../server/cors";

export const dynamic = "force-dynamic";

/** One read = everything the single screen needs (server drives the price fetch). */
export async function GET(request: NextRequest) {
  const preflight = tryPreflight(request);
  if (preflight) return preflight;
  try {
    const settings = await getSettings();

    // Expiry sweeps run before any display read: confirmed quotes whose timer
    // ran out settle right here (the trade executes "when the timer runs
    // out"), and stale actives expire. After this, balances and the receipt
    // history include the just-settled trade.
    await db
      .update(quotes)
      .set({ status: "expired" })
      .where(and(eq(quotes.status, "active"), lt(quotes.expiresAt, new Date())));
    await settleDueConfirmedQuotes();

    const [balances, snapshot, recentTrades] = await Promise.all([
      getBalances(),
      getPrice(settings),
      getRecentTrades(10),
    ]);

    // Same gate the quote route enforces. When the price fails the gate
    // (all sources off, or a lone non-PakGold source, past the max price
    // age) the price is WITHHELD from the state entirely — the UI shows the
    // notice, not a number we no longer stand behind. force_paused differs:
    // there the last price is display info, so it stays on screen.
    const gate = tradingGate(snapshot, settings);
    const withholdPrice = !gate.ok && gate.code === "PRICE_UNAVAILABLE";
    const priceNotice = gate.ok ? null : gate.message;

    // A confirmed quote stays on the card (it is the in-flight trade), so it
    // is as adoptable as an active one.
    const activeQuotes = await db
      .select()
      .from(quotes)
      .where(and(inArray(quotes.status, ["active", "confirmed"]), gt(quotes.expiresAt, new Date())))
      .orderBy(desc(quotes.createdAt))
      .limit(1);

    // The trades table stores only the deltas, so the receipt history walks it
    // backwards from the wallet it can see right now: this trade's balances
    // after = wallet at hand, its before = wallet reversed by the delta. Exact
    // bigint arithmetic server-side (the client never does money maths).
    let walkPkrPaisa = balances.pkrPaisa;
    let walkGoldMicrograms = balances.userGoldMicrograms;
    let walkPlatformMicrograms = balances.platformGoldMicrograms;
    const balanceByTradeId = new Map<
      string,
      { after: BalanceSnapshot; before: BalanceSnapshot }
    >();
    for (const trade of recentTrades) {
      const after: BalanceSnapshot = {
        pkrPaisa: walkPkrPaisa,
        userGoldMicrograms: walkGoldMicrograms,
        platformGoldMicrograms: walkPlatformMicrograms,
      };
      const buy = trade.side === "buy";
      const before: BalanceSnapshot = {
        pkrPaisa: buy ? walkPkrPaisa + trade.pkrPaisa : walkPkrPaisa - trade.pkrPaisa,
        userGoldMicrograms: buy
          ? walkGoldMicrograms - trade.goldMicrograms
          : walkGoldMicrograms + trade.goldMicrograms,
        platformGoldMicrograms: buy
          ? walkPlatformMicrograms + trade.goldMicrograms
          : walkPlatformMicrograms - trade.goldMicrograms,
      };
      balanceByTradeId.set(trade.id, { after, before });
      walkPkrPaisa = before.pkrPaisa;
      walkGoldMicrograms = before.userGoldMicrograms;
      walkPlatformMicrograms = before.platformGoldMicrograms;
    }

    return withCors(
      NextResponse.json({
        now: new Date().toISOString(),
        balances: balancesWire(balances),
        price: withholdPrice ? null : priceWire(snapshot),
        price_notice: priceNotice,
        active_quote: activeQuotes[0] ? quoteWire(activeQuotes[0], { now: new Date() }) : null,
        trades: recentTrades.map((t) => {
          const at = balanceByTradeId.get(t.id);
          return tradeWire(t, {
            balances: at?.after,
            balancesBefore: at?.before,
          });
        }),
        settings: settingsWire(settings),
      }),
    );
  } catch (err) {
    console.error("[/api/state]", err);
    return withCors(
      NextResponse.json(
        { error: { code: "INTERNAL", message: "Could not load state." } },
        { status: 500 },
      ),
    );
  }
}
