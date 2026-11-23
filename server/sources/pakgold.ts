import { ingestUsdPerTroyOz } from '../../domain/units';
import type { FxResult } from './fx';
import {
  describeFetchError,
  failure,
  type Sample,
} from './types';

const GOLD_URL = 'https://api.gold-api.com/price/XAU';
const TIMEOUT_MS = 8_000;

/**
 * PakGold methodology reproduced server-side: gold-api XAU (USD/troy oz) ×
 * er-api USD/PKR, normalised to paisa per gram of 24K gold.
 *
 * A contributes no provider clock: gold-api's `updatedAt` ticks while the value
 * stands still.
 */
export async function fetchPakgold(fx: FxResult): Promise<Sample> {
  if (!fx.ok) {
    return failure('A_pakgold', `FX leg failed: ${fx.reason}`);
  }

  let usdPerOz: number;
  try {
    const response = await fetch(GOLD_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return failure('A_pakgold', `gold-api HTTP ${response.status}`);
    }
    const data = (await response.json()) as { price?: unknown };
    usdPerOz = Number(data.price);
    if (!Number.isFinite(usdPerOz) || usdPerOz <= 0) {
      return failure('A_pakgold', 'bad payload: price missing');
    }
  } catch (error) {
    return failure('A_pakgold', `gold-api: ${describeFetchError(error)}`);
  }

  try {
    const paisaPerGram = ingestUsdPerTroyOz(usdPerOz, fx.rate);
    return {
      source: 'A_pakgold',
      ok: true,
      paisaPerGram,
      providerAt: null,
      note: `XAU $${usdPerOz.toFixed(2)}/oz × ${fx.rate.toFixed(4)} PKR/USD`,
    };
  } catch {
    return failure('A_pakgold', 'bad payload: price out of range');
  }
}
