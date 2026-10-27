import { and, desc, eq, lt } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../server/db";
import { quotes } from "../../../server/db/schema";
import { getBalances, getRecentTrades, getSettings, type BalanceSnapshot } from "../../../server/db/repo";
import { getPrice } from "../../../server/pricing/price";
import { balancesWire, priceWire, quoteWire, settingsWire, tradeWire } from "../../../server/serialize";
import { tryPreflight, withCors } from "../../../server/cors";

export const dynamic = "force-dynamic";

/** One read = everything the single screen needs (server drives the price fetch). */
export async function GET(request: NextRequest) {
  const preflight = tryPreflight(request);
  if (preflight) return preflight;
  try {
    const settings = await getSettings();
    const [balances, snapshot, recentTrades] = await Promise.all([
      getBalances(),
      getPrice(settings),
      getRecentTrades(10),
    ]);

    // Opportunistic sweep (same rule settleQuote uses): a quote past its clock
    // is expired, so /api/state never re-serves it as adoptable.
    await db
      .update(quotes)
      .set({ status: "expired" })
      .where(and(eq(quotes.status, "active"), lt(quotes.expiresAt, new Date())));

    const activeQuotes = await db
      .select()
      .from(quotes)
      .where(and(eq(quotes.status, "active")))
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
        price: priceWire(snapshot),
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
