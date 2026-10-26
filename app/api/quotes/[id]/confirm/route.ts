import { NextResponse } from "next/server";
import { getSettings } from "../../../../../server/db/repo";
import { getPrice } from "../../../../../server/pricing/price";
import { errorJson } from "../../../../../server/http";
import { tradeWire } from "../../../../../server/serialize";
import { settleQuote } from "../../../../../server/db/repo";
import { formatMicrograms, formatPaisa, toWire } from "../../../../../domain/units";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  try {
    const result = await settleQuote(id);

    switch (result.outcome) {
      case "settled": {
        return NextResponse.json({
          replayed: false,
          receipt: tradeWire(result.trade, {
            balances: result.balancesAfter,
            balancesBefore: result.balancesBefore,
          }),
        });
      }
      case "replayed": {
        // Double confirm -> one trade, same receipt (§5.2 row 1).
        return NextResponse.json({
          replayed: true,
          receipt: tradeWire(result.trade, { balances: result.balancesAfter }),
        });
      }
      case "expired": {
        // §5.2 row 2: expired confirm -> 409 QUOTE_EXPIRED, current price +
        // price_change_bps so the UI can offer "get a fresh quote".
        const settings = await getSettings();
        const snapshot = await getPrice(settings);
        const change =
          snapshot.marketPaisaPerGram === null
            ? null
            : Number(
                ((snapshot.marketPaisaPerGram - result.quote.marketPaisaPerGram) * 20000n) /
                  (snapshot.marketPaisaPerGram + result.quote.marketPaisaPerGram),
              );
        return errorJson(
          {
            code: "QUOTE_EXPIRED",
            message: "This quote expired — the price is owned by a new one now.",
            hint: "Get a fresh quote; your amount and side are preserved.",
            detail: {
              expired_at: result.quote.expiresAt.toISOString(),
              quoted_market_paisa_per_gram: toWire(result.quote.marketPaisaPerGram),
              current_market_paisa_per_gram:
                snapshot.marketPaisaPerGram === null ? null : toWire(snapshot.marketPaisaPerGram),
              price_change_bps: change,
            },
          },
          409,
        );
      }
      case "cancelled":
        return errorJson(
          {
            code: "QUOTE_CANCELLED",
            message: "This quote was cancelled.",
            hint: "Issue a new quote to continue.",
          },
          409,
        );
      case "rejected":
        return errorJson(
          {
            code: "QUOTE_REJECTED",
            message: "This quote was rejected.",
            hint: `${result.quote.rejectionReason ?? "balance check failed"} — balances may have moved since the quote.`,
            detail: { rejection_reason: result.quote.rejectionReason },
          },
          409,
        );
      case "shortfall":
        return errorJson(
          {
            code: result.code,
            message: result.message,
            hint:
              result.code === "INSUFFICIENT_PKR"
                ? `At the locked price you can afford ${formatMicrograms(result.maxAffordableMinor)} g.`
                : `You can afford up to ${formatMicrograms(result.maxAffordableMinor)} g (${formatPaisa(result.maxAffordableMinor)} in minor units).`,
            detail: {
              max_affordable_minor: toWire(result.maxAffordableMinor),
              max_affordable_unit: result.maxAffordableUnit,
            },
          },
          409,
        );
      case "quoteGone":
        return errorJson({ code: "NOT_FOUND", message: "No such quote." }, 404);
    }
  } catch (err) {
    console.error("[POST confirm]", err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not settle the trade." } },
      { status: 500 },
    );
  }
}
