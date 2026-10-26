import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../server/db";
import { quotes } from "../../../server/db/schema";
import { getBalances, getRecentTrades, getSettings } from "../../../server/db/repo";
import { getPrice } from "../../../server/pricing/price";
import { balancesWire, priceWire, quoteWire, settingsWire, tradeWire } from "../../../server/serialize";

export const dynamic = "force-dynamic";

/** One read = everything the single screen needs (server drives the price fetch). */
export async function GET() {
  try {
    const settings = await getSettings();
    const [balances, snapshot, recentTrades] = await Promise.all([
      getBalances(),
      getPrice(settings),
      getRecentTrades(10),
    ]);

    const activeQuotes = await db
      .select()
      .from(quotes)
      .where(and(eq(quotes.status, "active")))
      .orderBy(desc(quotes.createdAt))
      .limit(1);

    return NextResponse.json({
      now: new Date().toISOString(),
      balances: balancesWire(balances),
      price: priceWire(snapshot),
      active_quote: activeQuotes[0] ? quoteWire(activeQuotes[0], { now: new Date() }) : null,
      trades: recentTrades.map((t) => tradeWire(t, {})),
      settings: settingsWire(settings),
    });
  } catch (err) {
    console.error("[/api/state]", err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not load state." } },
      { status: 500 },
    );
  }
}
