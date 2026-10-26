import { NextResponse } from "next/server";
import { getSettings } from "../../../server/db/repo";
import { hotPrice } from "../../../server/pricing/price";
import { priceWire } from "../../../server/serialize";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const snapshot = await hotPrice(settings);
    return NextResponse.json({ now: new Date().toISOString(), price: priceWire(snapshot) });
  } catch (err) {
    console.error("[/api/price]", err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not read the price." } },
      { status: 500 },
    );
  }
}
