import { NextRequest, NextResponse } from "next/server";
import { getBalances, getTrade } from "../../../../server/db/repo";
import { errorJson } from "../../../../server/http";
import { tradeWire } from "../../../../server/serialize";
import { corsPreflight, withCors } from "../../../../server/cors";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const preflight = corsPreflight();
  if (preflight.status === 204) return preflight;

  try {
    const trade = await getTrade(id);
    if (!trade) {
      return withCors(errorJson({ code: "NOT_FOUND", message: "No such trade." }, 404));
    }
    const balances = await getBalances();
    return withCors(NextResponse.json({ receipt: tradeWire(trade, { balances }) }));
  } catch (err) {
    console.error("[GET trade]", err);
    return withCors(
      NextResponse.json(
        { error: { code: "INTERNAL", message: "Could not load the receipt." } },
        { status: 500 },
      ),
    );
  }
}
