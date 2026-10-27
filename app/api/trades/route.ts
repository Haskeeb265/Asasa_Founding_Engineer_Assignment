import { NextRequest, NextResponse } from "next/server";
import { getRecentTrades } from "../../../server/db/repo";
import { tradeWire } from "../../../server/serialize";
import { tryPreflight, withCors } from "../../../server/cors";

export const dynamic = "force-dynamic";

/** §7 Trade History — confirmed trades only (one entry per receipt), newest first. */
export async function GET(request: NextRequest) {
  const preflight = tryPreflight(request);
  if (preflight) return preflight;
  try {
    const rows = await getRecentTrades(50);
    return withCors(
      NextResponse.json({
        now: new Date().toISOString(),
        trades: rows.map((r) => tradeWire(r, {})),
      }),
    );
  } catch (err) {
    console.error("[GET /api/trades]", err);
    return withCors(
      NextResponse.json(
        { error: { code: "INTERNAL", message: "Could not load trade history." } },
        { status: 500 },
      ),
    );
  }
}
