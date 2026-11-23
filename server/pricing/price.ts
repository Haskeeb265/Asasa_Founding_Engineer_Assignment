import { randomUUID } from 'node:crypto';
import { toWire } from '../../domain/units';
import type { SourceId } from '../../domain/quorum';
import {
  getSettings,
  selectLatestCyclePrices,
  type PriceRow,
  type SettingsRow,
} from '../db/repo';
import { runCycle, type PriceSnapshot, type SnapshotSample } from './cycle';
import { cacheDel, cacheGet, cacheSet, cacheSetNx } from './redis';
import { sourceLabel } from './settings-like';

const CURRENT_KEY = 'price:current';
const COOLDOWN_KEY = 'price:next_fetch_at';
const CLAIM_SECONDS = 60;

function overrideSnapshot(settings: SettingsRow): PriceSnapshot {
  const price = settings.priceOverridePaisa as bigint;
  return {
    cycle_id: randomUUID(),
    fetched_at: new Date(),
    source: 'A_pakgold',
    paisa_per_gram: price,
    status: 'validated',
    degraded: false,
    degraded_reason: null,
    samples: [
      {
        source: 'A_pakgold',
        price_paisa_per_gram: price,
        accepted: true,
        selected: true,
        reason: 'demo price override',
        provider_at: null,
      },
    ],
    kind: 'override',
  };
}

function hydrateSnapshot(raw: unknown): PriceSnapshot | null {
  try {
    const value = raw as {
      cycle_id: string;
      fetched_at: string;
      source: SourceId | null;
      paisa_per_gram: string | null;
      status: PriceSnapshot['status'];
      degraded: boolean;
      degraded_reason: string | null;
      samples: Array<{
        source: SourceId;
        price_paisa_per_gram: string | null;
        accepted: boolean;
        selected: boolean;
        reason: string;
        provider_at: string | null;
        note?: string;
      }>;
      kind?: 'live' | 'override';
    };

    return {
      cycle_id: value.cycle_id,
      fetched_at: new Date(value.fetched_at),
      source: value.source,
      paisa_per_gram:
        value.paisa_per_gram === null ? null : BigInt(value.paisa_per_gram),
      status: value.status,
      degraded: Boolean(value.degraded),
      degraded_reason: value.degraded_reason ?? null,
      samples: value.samples.map((sample) => ({
        source: sample.source,
        price_paisa_per_gram:
          sample.price_paisa_per_gram === null
            ? null
            : BigInt(sample.price_paisa_per_gram),
        accepted: sample.accepted,
        selected: sample.selected,
        reason: sample.reason,
        provider_at: sample.provider_at ? new Date(sample.provider_at) : null,
        ...(sample.note ? { note: sample.note } : {}),
      })),
      kind: value.kind ?? 'live',
    };
  } catch {
    return null;
  }
}

async function readCache(): Promise<PriceSnapshot | null> {
  const cached = await cacheGet(CURRENT_KEY);
  if (!cached) return null;
  try {
    return hydrateSnapshot(JSON.parse(cached));
  } catch {
    return null;
  }
}

async function writeCache(
  snapshot: PriceSnapshot,
  ttlSeconds: number,
): Promise<void> {
  await cacheSet(CURRENT_KEY, JSON.stringify(toWire(snapshot)), ttlSeconds);
}

function snapshotFromRows(rows: PriceRow[]): PriceSnapshot | null {
  if (rows.length === 0) return null;
  const selectedRow =
    rows.find((row) => row.selected && row.pricePaisaPerGram !== null) ?? null;
  const acceptedRows = rows.filter(
    (row) => row.accepted && row.pricePaisaPerGram !== null,
  );
  const samples: SnapshotSample[] = rows.map((row) => ({
    source: row.source,
    price_paisa_per_gram: row.pricePaisaPerGram,
    accepted: row.accepted,
    selected: row.selected,
    reason: row.reason,
    provider_at: null,
  }));

  const source = selectedRow?.source ?? null;
  const degraded = source !== null && source !== 'A_pakgold';

  return {
    cycle_id: rows[0].cycleId,
    fetched_at: rows[0].fetchedAt,
    source,
    paisa_per_gram: selectedRow?.pricePaisaPerGram ?? null,
    status:
      source === null
        ? 'paused'
        : acceptedRows.length > 1
          ? 'validated'
          : 'single_source',
    degraded,
    degraded_reason: degraded
      ? `${sourceLabel(source, 'live')} selected from the last recorded cycle.`
      : null,
    samples,
    kind: 'live',
  };
}

/** Rebuild the newest recorded cycle from Postgres; no provider clock survives. */
export async function snapshotFromDb(): Promise<PriceSnapshot | null> {
  const rows = await selectLatestCyclePrices();
  return snapshotFromRows(rows);
}

/**
 * Lazy read-path fetch. Serves a cached price while it is inside the fetch
 * interval, otherwise claims a fetch so at most one request waits on a third
 * party. Failures cool down for 60s so a 403 storm never becomes a fetch storm.
 */
export async function getPrice(): Promise<PriceSnapshot | null> {
  const settings = await getSettings();
  if (settings.priceOverridePaisa !== null) {
    return overrideSnapshot(settings);
  }

  const cached = await readCache();
  if (
    cached &&
    Date.now() - cached.fetched_at.getTime() <=
      settings.priceFetchIntervalSeconds * 1000
  ) {
    return cached;
  }

  const claimed = await cacheSetNx(
    COOLDOWN_KEY,
    String(Date.now() + 20_000),
    CLAIM_SECONDS,
  );
  if (!claimed) return snapshotFromDb();

  try {
    const snapshot = await runCycle();
    if (snapshot.source !== null && snapshot.paisa_per_gram !== null) {
      await writeCache(snapshot, settings.priceFetchIntervalSeconds);
      return snapshot;
    }
    await cacheSet(COOLDOWN_KEY, String(Date.now() + 60_000), CLAIM_SECONDS);
    return (await snapshotFromDb()) ?? snapshot;
  } catch (error) {
    console.error(
      'Price cycle failed:',
      error instanceof Error ? error.message : error,
    );
    await cacheSet(COOLDOWN_KEY, String(Date.now() + 60_000), CLAIM_SECONDS);
    return snapshotFromDb();
  }
}

/** GET /api/price: override -> cache -> last recorded cycle. Never fetches. */
export async function peekPrice(): Promise<PriceSnapshot | null> {
  const settings = await getSettings();
  if (settings.priceOverridePaisa !== null) {
    return overrideSnapshot(settings);
  }
  const cached = await readCache();
  if (cached) return cached;
  return snapshotFromDb();
}

/** Demo force-cycle: ignore cache and cooldown, then refresh the cache. */
export async function forceCycle(): Promise<PriceSnapshot> {
  const settings = await getSettings();
  const snapshot = await runCycle();
  if (snapshot.source !== null && snapshot.paisa_per_gram !== null) {
    await writeCache(snapshot, settings.priceFetchIntervalSeconds);
  }
  return snapshot;
}

export async function invalidatePriceCache(): Promise<void> {
  await cacheDel(CURRENT_KEY);
  await cacheDel(COOLDOWN_KEY);
}
