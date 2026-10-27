import { desc } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../server/db";
import { balances, prices, quotes, settings } from "../../../server/db/schema";
import { getRecentTrades } from "../../../server/db/repo";
import { formatMicrograms, formatPaisa, toWire } from "../../../domain/units";
import { tradeWire } from "../../../server/serialize";
import { tryPreflight, withCors } from "../../../server/cors";

export const dynamic = "force-dynamic";

/**
 * Live-database mirror for /db (§8 style "status view"): every table's
 * latest rows, display strings computed server-side. Read-only.
 */

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export async function GET(request: NextRequest) {
  const preflight = tryPreflight(request);
  if (preflight) return preflight;
  try {
    const [balanceRows, settingsRows, quoteRows, priceRows, tradeRows] = await Promise.all([
      db.select().from(balances).orderBy(balances.key),
      db.select().from(settings).limit(1),
      db.select().from(quotes).orderBy(desc(quotes.createdAt)).limit(25),
      db.select().from(prices).orderBy(desc(prices.id)).limit(30),
      getRecentTrades(25),
    ]);

    return withCors(
      NextResponse.json({
        now: new Date().toISOString(),
        balances: balanceRows.map((b) => {
          const paisa = b.unit === "paisa";
          return {
            key: b.key,
            unit: b.unit,
            amount_minor: toWire(b.amount),
            display: b.key === "pkr" ? formatPaisa(b.amount) : formatMicrograms(b.amount),
            updated_at: iso(b.updatedAt),
            is_money: paisa,
          };
        }),
        settings: settingsRows.map((s) => ({
          guardrail_pkr_per_gram: Number(s.guardrailPaisaPerGram) / 100,
          quote_ttl_seconds: s.quoteTtlSeconds,
          divergence_threshold_bps: s.divergenceThresholdBps,
          max_price_age_seconds: s.maxPriceAgeSeconds,
          source_a_on: s.sourceAOn,
          source_b_on: s.sourceBOn,
          source_c_on: s.sourceCOn,
          source_c_basis_bps: s.sourceCBasisBps,
          price_override_pkr_per_gram:
            s.priceOverridePaisa === null ? null : Number(s.priceOverridePaisa) / 100,
          force_paused: s.forcePaused,
          updated_at: iso(s.updatedAt),
        })),
        quotes: quoteRows.map((q) => ({
          id: q.id,
          side: q.side,
          status: q.status,
          input_mode: q.inputMode,
          input_display:
            q.inputMode === "pkr" ? formatPaisa(q.inputMinor) : formatMicrograms(q.inputMinor),
          market_display: formatPaisa(q.marketPaisaPerGram),
          execution_display: formatPaisa(q.unitPaisaPerGram),
          gold_display: formatMicrograms(q.goldMicrograms),
          pkr_display: formatPaisa(q.pkrPaisa),
          guardrail_applied: q.guardrailApplied,
          price_source: q.priceSource,
          rejection_reason: q.rejectionReason,
          created_at: iso(q.createdAt),
          expires_at: iso(q.expiresAt),
          settled_at: iso(q.settledAt),
        })),
        trades: tradeRows.map((t) => tradeWire(t, {})),
        prices: priceRows.map((p) => ({
          id: p.id,
          cycle_id: p.cycleId,
          fetched_at: iso(p.fetchedAt),
          source: p.source,
          price_display: p.pricePaisaPerGram === null ? null : formatPaisa(p.pricePaisaPerGram),
          accepted: p.accepted,
          selected: p.selected,
          reason: p.reason,
        })),
      }),
    );
  } catch (err) {
    console.error("[GET /api/db]", err);
    return withCors(
      NextResponse.json(
        { error: { code: "INTERNAL", message: "Could not read the database." } },
        { status: 500 },
      ),
    );
  }
}
