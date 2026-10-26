import { NextResponse } from "next/server";
import { getBalances, getTrade } from "../../../../server/db/repo";
import { errorJson } from "../../../../server/http";
import { tradeWire } from "../../../../server/serialize";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  try {
    const trade = await getTrade(id);
    if (!trade) {
      return errorJson({ code: "NOT_FOUND", message: "No such trade." }, 404);
    }
    const balances = await getBalances();
    return NextResponse.json({ receipt: tradeWire(trade, { balances }) });
  } catch (err) {
    console.error("[GET trade]", err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not load the receipt." } },
      { status: 500 },
    );
  }
}
