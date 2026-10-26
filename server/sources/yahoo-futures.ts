import { marketPaisaPerGramFromUsdPerOz } from "../../domain/units";
import type { SourceId, SourceResult } from "./types";
import { fetchJson, reasonOf } from "./types";
import { usdPkrOrThrow } from "./fx";

const CHART_URL_TEMPLATE = "https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}?interval=5m&range=1d";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SOURCE: SourceId = "C_yahoo";

/**
 * Source C — the only leg guaranteed reachable from serverless hosts.
 * GC=F is a futures contract, so the raw print is normalised to a
 * spot-equivalent with the measured basis (§6.1.1) before it is compared or
 * published. If the real basis drifts from the allowance, C diverges and the
 * quorum rejects it — that is the desired signal, not something to hide.
 *
 * meta only. The candle series returns malformed pre-open; regularMarketPrice
 * and regularMarketTime are the reliable, honest-clock facts.
 */
export async function fetchYahooFutures(basisBps: number): Promise<SourceResult> {
  try {
    const symbol = process.env.YAHOO_SYMBOL || "GC=F";
    const url = CHART_URL_TEMPLATE.replace("{SYMBOL}", encodeURIComponent(symbol));

    const [data, pkrPerUsd] = await Promise.all([
      fetchJson(url, { headers: { "user-agent": BROWSER_UA } }, 10_000) as Promise<{
        chart?: { result?: Array<{ meta?: Record<string, unknown> }> }
      }>,
      usdPkrOrThrow(),
    ]);

    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) return { ok: false, reason: "Yahoo chart response had no meta" };

    const rawUsdPerOz = meta.regularMarketPrice;
    const marketSeconds = meta.regularMarketTime;
    if (typeof rawUsdPerOz !== "number" || !Number.isFinite(rawUsdPerOz) || rawUsdPerOz <= 0) {
      return { ok: false, reason: `meta.regularMarketPrice unusable: ${String(rawUsdPerOz)}` };
    }
    if (typeof marketSeconds !== "number" || !Number.isFinite(marketSeconds) || marketSeconds <= 0) {
      return { ok: false, reason: `meta.regularMarketTime unusable: ${String(marketSeconds)}` };
    }

    // c_spot = c_raw x 10000 / (10000 + basis) — the measured offset removed...
    const spotEquivalent = (rawUsdPerOz * 10_000) / (10_000 + basisBps);

    return {
      ok: true,
      quote: {
        source: SOURCE,
        paisaPerGram: marketPaisaPerGramFromUsdPerOz(spotEquivalent, pkrPerUsd),
        providerSeconds: Math.round(marketSeconds),
        raw: {
          gc_f: rawUsdPerOz,
          basis_bps: basisBps,
          spot_equivalent: Number(spotEquivalent.toFixed(4)),
          usd_pkr: pkrPerUsd,
        },
      },
    };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}
