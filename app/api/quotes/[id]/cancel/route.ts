import { NextRequest, NextResponse } from "next/server";
import { cancelQuote } from "../../../../../server/db/repo";
import { errorJson } from "../../../../../server/http";
import { corsPreflight, withCors } from "../../../../../server/cors";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const preflight = corsPreflight();
  if (preflight.status === 204) return preflight;

  try {
    const result = await cancelQuote(id);

    switch (result.outcome) {
      case "cancelled":
      case "alreadyCancelled":
        return withCors(NextResponse.json({ quote: { id, status: "cancelled" } }));
      case "expired":
        return withCors(
          errorJson(
            { code: "QUOTE_EXPIRED", message: "This quote already expired; nothing to cancel." },
            409,
          ),
        );
      case "settled":
        return withCors(
          errorJson(
            { code: "QUOTE_SETTLED", message: "This quote already settled — see your receipt." },
            409,
          ),
        );
      case "rejected":
        return withCors(
          errorJson({ code: "QUOTE_REJECTED", message: "This quote was already rejected." }, 409),
        );
      case "quoteGone":
        return withCors(errorJson({ code: "NOT_FOUND", message: "No such quote." }, 404));
    }
  } catch (err) {
    console.error("[POST cancel]", err);
    return withCors(
      NextResponse.json(
        { error: { code: "INTERNAL", message: "Could not cancel the quote." } },
        { status: 500 },
      ),
    );
  }
}
