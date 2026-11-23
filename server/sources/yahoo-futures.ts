import { ingestUsdPerTroyOz } from '../../domain/units';
import type { FxResult } from './fx';
import { describeFetchError, failure, type Sample } from './types';

const TIMEOUT_MS = 8_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

interface YahooMeta {
  regularMarketPrice?: unknown;
  regularMarketTime?: unknown;
}

/**
 * Yahoo GC=F is a futures contract, measured about +0.275% over spot. The raw
 * print is normalised by the configurable basis before comparison and
 * publication. Read `meta` only: the candle series is malformed pre-open.
 */
export async function fetchYahooFutures(
  fx: FxResult,
  basisBps: number,
): Promise<Sample> {
  if (!fx.ok) return failure('C_yahoo', 'no FX rate');

  const symbol = process.env.YAHOO_SYMBOL?.trim() || 'GC=F';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?interval=5m&range=1d`;

  let rawUsd: number;
  let providerAt: Date | null = null;
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    });
    if (!response.ok) {
      return failure('C_yahoo', `Yahoo HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      chart?: {
        result?: Array<{ meta?: YahooMeta }>;
        error?: { description?: string } | null;
      };
    };
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) {
      const description = data.chart?.error?.description;
      return failure(
        'C_yahoo',
        description ? `bad payload: ${description}` : 'bad payload: meta missing',
      );
    }

    rawUsd = Number(meta.regularMarketPrice);
    if (!Number.isFinite(rawUsd) || rawUsd <= 0) {
      return failure('C_yahoo', 'bad payload: regularMarketPrice missing');
    }

    const time = Number(meta.regularMarketTime);
    if (Number.isFinite(time) && time > 0) {
      providerAt = new Date(time * 1000);
    }
  } catch (error) {
    return failure('C_yahoo', `Yahoo: ${describeFetchError(error)}`);
  }

  const spotUsd = (rawUsd * 10_000) / (10_000 + basisBps);
  try {
    return {
      source: 'C_yahoo',
      ok: true,
      paisaPerGram: ingestUsdPerTroyOz(spotUsd, fx.rate),
      providerAt,
      note: `GC=F $${rawUsd.toFixed(2)}/oz, basis ${basisBps} bps`,
    };
  } catch {
    return failure('C_yahoo', 'bad payload: price out of range');
  }
}
