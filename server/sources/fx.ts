import { kvGet, kvSet, KEY_FX } from "../pricing/redis";
import { fetchJson, reasonOf } from "./types";

const ER_API_URL = "https://open.er-api.com/v6/latest/USD";
const FX_TTL_SECONDS = 6 * 60 * 60; // er-api updates ~daily; 6 h is freshly-lagged, not stale-lagged

/** USDtoPKR: PKR per 1 USD. Cached 6 h; cache loss just means one refetch. */
export async function getUsdPkr(): Promise<number> {
  const cached = await kvGet<number>(KEY_FX);
  if (typeof cached === "number" && cached > 0) return cached;

  const data = await fetchJson(ER_API_URL, {}, 15_000) as { rates?: Record<string, number> } | null;
  const pkr = data?.rates?.PKR;
  if (typeof pkr !== "number" || !Number.isFinite(pkr) || pkr <= 0) {
    throw new Error("FX response did not contain a usable rates.PKR");
  }
  await kvSet(KEY_FX, pkr, FX_TTL_SECONDS);
  return pkr;
}

/** One attempt, loud failure — the cycle treats FX loss as source A loss, not a silent rebase. */
export function usdPkrOrThrow(): Promise<number> {
  return getUsdPkr().catch((err) => {
    throw new Error(`FX leg failed: ${reasonOf(err)}`);
  });
}
