import { marketPaisaPerGramFromUsdPerOz } from "../../domain/units";
import type { SourceId, SourceResult } from "./types";
import { fetchJson, reasonOf } from "./types";
import { usdPkrOrThrow } from "./fx";

const GOLD_API_URL = "https://api.gold-api.com/price/XAU";
const SOURCE: SourceId = "A_pakgold";

/**
 * Source A = the brief's primary. PakGold computes exactly this in the
 * browser (verified from their page source): XAU/USD spot from gold-api
 * multiplied by USD/PKR from er-api. §6.6: gold-api's `updatedAt` ticks while
 * the value stands still, so providerSeconds stays null — freshness comes
 * from the value, never from that clock.
 */
export async function fetchPakGold(): Promise<SourceResult> {
  try {
    const [data, pkrPerUsd] = await Promise.all([
      fetchJson(GOLD_API_URL, {}, 10_000) as Promise<{ price?: number }>,
      usdPkrOrThrow(),
    ]);

    const priceUsdPerOz = data.price;
    if (typeof priceUsdPerOz !== "number" || !Number.isFinite(priceUsdPerOz) || priceUsdPerOz <= 0) {
      return { ok: false, reason: `gold-api returned unusable price ${String(priceUsdPerOz)}` };
    }

    return {
      ok: true,
      quote: {
        source: SOURCE,
        paisaPerGram: marketPaisaPerGramFromUsdPerOz(priceUsdPerOz, pkrPerUsd),
        providerSeconds: null,
        raw: { usd_per_oz: priceUsdPerOz, usd_pkr: pkrPerUsd, legs: "gold-api + er-api" },
      },
    };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}
