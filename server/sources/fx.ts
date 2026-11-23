import { cacheGet, cacheSet } from '../pricing/redis';
import { describeFetchError } from './types';

const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const FX_CACHE_KEY = 'fx:usd_pkr';
const FX_TTL_SECONDS = 6 * 60 * 60;
const TIMEOUT_MS = 8_000;

export type FxResult =
  | { ok: true; rate: number }
  | { ok: false; reason: string };

/**
 * USD -> PKR, cached for six hours. FX updates roughly daily, so this leg is
 * not tick-live (documented known gap).
 */
export async function getUsdPkr(): Promise<FxResult> {
  const cached = await cacheGet(FX_CACHE_KEY);
  if (cached) {
    const rate = Number(cached);
    if (Number.isFinite(rate) && rate > 0) return { ok: true, rate };
  }

  try {
    const response = await fetch(FX_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { ok: false, reason: `FX HTTP ${response.status}` };

    const data = (await response.json()) as {
      result?: string;
      rates?: Record<string, unknown>;
    };
    if (data.result !== 'success') {
      return { ok: false, reason: 'FX bad payload: result not success' };
    }
    const rate = Number(data.rates?.PKR);
    if (!Number.isFinite(rate) || rate <= 0) {
      return { ok: false, reason: 'FX bad payload: rates.PKR missing' };
    }

    await cacheSet(FX_CACHE_KEY, String(rate), FX_TTL_SECONDS);
    return { ok: true, rate };
  } catch (error) {
    return { ok: false, reason: `FX: ${describeFetchError(error)}` };
  }
}
