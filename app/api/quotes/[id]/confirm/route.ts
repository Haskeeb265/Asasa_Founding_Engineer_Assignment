import { NextRequest, NextResponse } from "next/server";
import { confirmQuote, getSettings } from "../../../../../server/db/repo";
import { getPrice } from "../../../../../server/pricing/price";
import { errorJson } from "../../../../../server/http";
import { quoteWire } from "../../../../../server/serialize";
import { toWire } from "../../../../../domain/units";
import { tryPreflight, withCors } from "../../../../../server/cors";

export const dynamic = "force-dynamic";

/**
 * Confirm now means stage 1: the quote flips to `confirmed` and holds its
 * price, but the trade does not execute until the quote's own timer runs out
 * (stage 2, the expiry sweep in /api/state and the background tick). The
 * confirm is idempotent — pressing it twice still confirms once — and cancel
 * stays open the whole time.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const preflight = tryPreflight(request);
  if (preflight) return preflight;

  try {
    const result = await confirmQuote(id);

    switch (result.outcome) {
      case "confirmed":
      case "replayed": {
        return withCors(
          NextResponse.json({
            confirmed: true,
            replayed: result.outcome === "replayed",
            quote: quoteWire(result.quote, { now: new Date() }),
          }),
        );
      }
      case "settled": {
        // A confirm landing on an already-settled quote: settled past is past.
        return withCors(
          errorJson(
            {
              code: "QUOTE_SETTLED",
              message: "This quote already settled — see your receipt.",
            },
            409,
          ),
        );
      }
      case "expired": {
        // The timer ran out before the confirm landed; the price is owned
        // by a new one now, so the response carries the current price and
        // price_change_bps for a "get a fresh quote" affordance.
        const settings = await getSettings();
        const snapshot = await getPrice(settings);
        const change =
          snapshot.marketPaisaPerGram === null
            ? null
            : Number(
                ((snapshot.marketPaisaPerGram - result.quote.marketPaisaPerGram) * 20000n) /
                  (snapshot.marketPaisaPerGram + result.quote.marketPaisaPerGram),
              );
        return withCors(
          errorJson(
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
          ),
        );
      }
      case "cancelled":
        return withCors(
          errorJson(
            {
              code: "QUOTE_CANCELLED",
              message: "This quote was cancelled.",
              hint: "Issue a new quote to continue.",
            },
            409,
          ),
        );
      case "rejected":
        return withCors(
          errorJson(
            {
              code: "QUOTE_REJECTED",
              message: "This quote was rejected.",
              hint: `${result.quote.rejectionReason ?? "balance check failed"} — balances may have moved since the quote.`,
              detail: { rejection_reason: result.quote.rejectionReason },
            },
            409,
          ),
        );
      case "quoteGone":
        return withCors(errorJson({ code: "NOT_FOUND", message: "No such quote." }, 404));
    }
  } catch (err) {
    console.error("[POST confirm]", err);
    return withCors(
      NextResponse.json(
        { error: { code: "INTERNAL", message: "Could not confirm the quote." } },
        { status: 500 },
      ),
    );
  }
}
