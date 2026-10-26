import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "../../../server/db/repo";
import { hotPrice } from "../../../server/pricing/price";
import { priceWire } from "../../../server/serialize";
import { tryPreflight, withCors } from "../../../server/cors";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const preflight = tryPreflight(request);
  if (preflight) return preflight;

  try {
    const settings = await getSettings();
    const snapshot = await hotPrice(settings);
    return withCors(
      NextResponse.json({ now: new Date().toISOString(), price: priceWire(snapshot) }),
    );
  } catch (err) {
    console.error("[/api/price]", err);
    return withCors(
      NextResponse.json(
        { error: { code: "INTERNAL", message: "Could not read the price." } },
        { status: 500 },
      ),
    );
  }
}
