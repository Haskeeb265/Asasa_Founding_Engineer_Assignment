import { ingestUsdPerTroyOz } from '../../domain/units';
import type { FxResult } from './fx';
import { describeFetchError, failure, type Sample } from './types';

const TIMEOUT_MS = 7_000;
const HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];
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
  const path = `/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?interval=5m&range=1d`;

  let rawUsd = 0;
  let providerAt: Date | null = null;
  let lastError = 'no response';

  // query1 and query2 serve the same data. A timeout or edge error on one is
  // usually transient, so try the other before failing the source.
  for (const host of HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      if (!response.ok) {
        lastError = `Yahoo HTTP ${response.status}`;
        continue;
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
      break;
    } catch (error) {
      lastError = `Yahoo: ${describeFetchError(error)}`;
    }
  }

  if (rawUsd <= 0) {
    return failure('C_yahoo', lastError);
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
