import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { divergenceBps } from "../../../domain/quorum";
import { parseGoldAmount, parsePkrAmount } from "../../../domain/units";
import { buildQuote, type InputMode, type Side } from "../../../domain/trade-math";
import { getQuote, getSettings, insertQuoteTerms } from "../../../server/db/repo";
import { getPrice, tradingGate } from "../../../server/pricing/price";
import { errorJson, type ErrorCode } from "../../../server/http";
import { quoteWire } from "../../../server/serialize";
import { tryPreflight, withCors } from "../../../server/cors";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  side: z.enum(["buy", "sell"]),
  input_mode: z.enum(["pkr", "gold"]),
  input: z.union([z.string(), z.number()]),
  from_quote_id: z.string().uuid().optional(),
});

function parseInput(raw: unknown, inputMode: InputMode) {
  return inputMode === "pkr" ? parsePkrAmount(raw) : parseGoldAmount(raw);
}

export async function POST(request: NextRequest) {
  const preflight = tryPreflight(request);
  if (preflight) return preflight;
  try {
    const json = await request.json().catch(() => null);
    const parsedBody = bodySchema.safeParse(json);
    if (!parsedBody.success) {
      return errorJson({
        code: "INVALID_AMOUNT",
        message: "Send { side: 'buy'|'sell', input_mode: 'pkr'|'gold', input: number }.",
        hint: parsedBody.error.issues.map((i) => i.message).join("; "),
      });
    }
    const { side: sideRaw, input_mode: inputModeRaw, input, from_quote_id } = parsedBody.data;
    const side = sideRaw as Side;
    const inputMode = inputModeRaw as InputMode;

    const settings = await getSettings();

    // §5.3: the request tells the story of the previous quote.
    const fromQuote = from_quote_id ? await getQuote(from_quote_id) : null;

    const parse = parseInput(input, inputMode);
    if (!parse.ok) return errorJson({ code: parse.code, message: parse.message });

    const snapshot = await getPrice(settings);
    const gate = tradingGate(snapshot, settings);
    if (gate !== null || snapshot.marketPaisaPerGram === null || snapshot.source === null) {
      return errorJson({
        code: (gate ?? "PRICE_UNAVAILABLE") as ErrorCode,
        message:
          gate === "TRADING_PAUSED"
            ? "Trading is paused right now."
            : "No usable market price — every source failed or the price is too old.",
        hint: `Last published price age: ${snapshot.marketAgeSeconds === null ? "unknown" : `${snapshot.marketAgeSeconds} s`} — ${snapshot.reason ?? "no special conditions"}`,
        detail: { price: snapshot.marketPaisaPerGram === null ? null : snapshot.reason },
      });
    }

    const terms = buildQuote({
      side,
      inputMode,
      inputMinor: parse.value,
      marketPaisaPerGram: snapshot.marketPaisaPerGram,
      guardrailPaisaPerGram: settings.guardrailPaisaPerGram,
    });
    if (!terms.ok) return errorJson({ code: terms.code, message: terms.message });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.quoteTtlSeconds * 1000);
    const row = await insertQuoteTerms(terms.value, {
      expiresAt,
      priceCycleId: snapshot.cycleId,
      priceFetchedAtSeconds: snapshot.fetchedAtSeconds,
      priceSource: snapshot.source,
    });

    const priceChangeBps =
      fromQuote && snapshot.marketPaisaPerGram !== null
        ? divergenceBps(fromQuote.marketPaisaPerGram, snapshot.marketPaisaPerGram)
        : null;

    return withCors(
      NextResponse.json(
        {
          quote: quoteWire(row, { now: new Date() }),
          price_change_bps: priceChangeBps,
        },
        { status: 201 },
      ),
    );
  } catch (err) {
    console.error("[POST /api/quotes]", err);
    return withCors(
      NextResponse.json(
        { error: { code: "INTERNAL", message: "Could not create a quote." } },
        { status: 500 },
      ),
    );
  }
}
