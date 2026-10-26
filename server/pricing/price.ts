import { db } from "../db";
import { prices } from "../db/schema";
import {
  KEY_CURRENT,
  KEY_NEXT_FETCH_AT,
  kvGet,
  kvSet,
  kvSetNx,
} from "./redis";
import { runPricingCycle, type PriceSampleRow } from "./cycle";
import type { SettingsLike } from "./settings-like";
import type { Confidence, SourceId } from "../../domain/quorum";
import type { ErrorCode } from "../http";

const PRICE_TTL_SECONDS = 300;
const FETCH_WINDOW_SECONDS = 20;
const FAILURE_BACKOFF_SECONDS = 60;

export interface PriceSnapshot {
  marketPaisaPerGram: bigint | null;
  source: SourceId | null; // null => paused
  confidence: Confidence;
  degraded: boolean;
  /** Set when a demo override produced this price instead of the market. */
  overridden: boolean;
  cycleId: string | null;
  /** When the cycle that produced this number ran (epoch s). */
  fetchedAtSeconds: number;
  /** Best provider market clock for this number (epoch s), null if none usable. */
  providerSeconds: number | null;
  /** now - max(usable provider stamps); null = unknown, never fake it. */
  marketAgeSeconds: number | null;
  reason: string | null;
  samples: PriceSampleRow[];
}

interface CacheShape {
  market: string; // bigint serialised as string for JSON
  source: SourceId | null;
  confidence: Confidence;
  degraded: boolean;
  cycleId: string | null;
  fetchedAtSeconds: number;
  providerSeconds: number | null;
  samples: Array<{ source: SourceId; price: string | null; accepted: boolean; reason: string | null }>;
}

const epochNow = (): number => Math.floor(Date.now() / 1000);

function snapshotFromCache(cached: CacheShape): PriceSnapshot {
  const age = epochNow() - cached.fetchedAtSeconds;
  return {
    marketPaisaPerGram: BigInt(cached.market),
    source: cached.source,
    confidence: cached.confidence,
    degraded: cached.degraded,
    overridden: false,
    cycleId: cached.cycleId,
    fetchedAtSeconds: cached.fetchedAtSeconds,
    providerSeconds: cached.providerSeconds,
    marketAgeSeconds: cached.providerSeconds === null ? age : epochNow() - cached.providerSeconds,
    reason: null,
    samples: (cached.samples ?? []).map((s) => ({
      source: s.source,
      ok: true,
      pricePaisaPerGram: s.price === null ? null : BigInt(s.price),
      accepted: s.accepted,
      selected: s.source === cached.source,
      reason: s.reason,
    })),
  };
}

/**
 * `/api/price` hot read: cache -> DB record, one expression, never a fetch
 * (spec §9). `getPrice` below is the full §6.3 lazy orchestrator.
 */
export async function hotPrice(settings: SettingsLike): Promise<PriceSnapshot> {
  if (settings.priceOverridePaisa !== null && settings.priceOverridePaisa > 0n) {
    return {
      marketPaisaPerGram: settings.priceOverridePaisa,
      source: "A_pakgold",
      confidence: "single_source",
      degraded: true,
      overridden: true,
      cycleId: null,
      fetchedAtSeconds: epochNow(),
      providerSeconds: null,
      marketAgeSeconds: 0,
      reason: "demo price override active (not a market price)",
      samples: [],
    };
  }
  const cached = await kvGet<CacheShape>(KEY_CURRENT);
  if (!cached) return snapshotFromDb(settings, "no cached price yet");
  if (epochNow() - cached.fetchedAtSeconds > PRICE_TTL_SECONDS) {
    return snapshotFromDb(settings, "cached price expired");
  }
  return snapshotFromCache(cached);
}

export async function getPrice(settings: SettingsLike, force = false): Promise<PriceSnapshot> {
  // Demo override (§8): a synthetic price the evaluator set, clearly labelled.
  if (settings.priceOverridePaisa !== null && settings.priceOverridePaisa > 0n) {
    return {
      marketPaisaPerGram: settings.priceOverridePaisa,
      source: "A_pakgold",
      confidence: "single_source",
      degraded: true,
      overridden: true,
      cycleId: null,
      fetchedAtSeconds: epochNow(),
      providerSeconds: null,
      marketAgeSeconds: 0,
      reason: "demo price override active (not a market price)",
      samples: [],
    };
  }

  if (!force) {
    const cached = await kvGet<CacheShape>(KEY_CURRENT);
    if (cached && epochNow() - cached.fetchedAtSeconds <= PRICE_TTL_SECONDS) {
      return snapshotFromCache(cached);
    }
  }

  // Cooldown: set on success AND failure; a 403 storm must not become a fetch
  // storm. The claim doubles as the cooldown check — if the key still holds an
  // unexpired window (success or failure), the claim fails and we serve the
  // durable record until it lapses.
  const claim = await kvSetNx(KEY_NEXT_FETCH_AT, epochNow() + FETCH_WINDOW_SECONDS, FAILURE_BACKOFF_SECONDS);

  if (!force && claim === null) {
    // Someone else is fetching; serve the durable record while we wait.
    return await snapshotFromDb(settings, "a price fetch is already in flight");
  }

  try {
    const cycle = await runPricingCycle(settings);
    if (cycle.selectedSource === null || cycle.selectedPrice === null) {
      // All sources failed: honest pause + 60 s backoff (§6.3).
      await kvSet(KEY_NEXT_FETCH_AT, epochNow() + FAILURE_BACKOFF_SECONDS, FAILURE_BACKOFF_SECONDS);
      return await snapshotFromDb(settings, "every source failed this cycle — trading paused");
    }

    const cacheValue: CacheShape = {
      market: cycle.selectedPrice.toString(),
      source: cycle.selectedSource,
      confidence: cycle.confidence,
      degraded: cycle.degraded,
      cycleId: cycle.cycleId,
      fetchedAtSeconds: cycle.fetchedAtSeconds,
      providerSeconds: cycle.providerSeconds,
      samples: cycle.samples.map((s) => ({
        source: s.source,
        price: s.pricePaisaPerGram === null ? null : s.pricePaisaPerGram.toString(),
        accepted: s.accepted,
        reason: s.reason,
      })),
    };
    await kvSet(KEY_CURRENT, cacheValue, PRICE_TTL_SECONDS);

    return {
      marketPaisaPerGram: cycle.selectedPrice,
      source: cycle.selectedSource,
      confidence: cycle.confidence,
      degraded: cycle.degraded,
      overridden: false,
      cycleId: cycle.cycleId,
      fetchedAtSeconds: cycle.fetchedAtSeconds,
      providerSeconds: cycle.providerSeconds,
      marketAgeSeconds: cycle.providerSeconds === null
        ? epochNow() - cycle.fetchedAtSeconds
        : epochNow() - cycle.providerSeconds,
      reason: null,
      samples: cycle.samples,
    };
  } catch (err) {
    console.error("[pricing] cycle threw:", err);
    await kvSet(KEY_NEXT_FETCH_AT, epochNow() + FAILURE_BACKOFF_SECONDS, FAILURE_BACKOFF_SECONDS);
    return await snapshotFromDb(settings, "the pricing cycle errored — serving the last recorded cycle");
  }
}

/**
 * Durable fallback: the `prices` table can always rebuild the last cycle, so
 * cache loss never blanks the price panel.
 */
export async function snapshotFromDb(settings: SettingsLike, reason: string): Promise<PriceSnapshot> {
  void settings;
  const rows = await db.select().from(prices).orderBy(prices.fetchedAt).limit(60);

  // The latest cycle = the run of identical consecutive cycleIds from the end.
  let latestCycleId: string | null = null;
  const ordered = [...rows].reverse();
  for (const row of ordered) {
    if (latestCycleId === null) {
      latestCycleId = row.cycleId;
    } else if (row.cycleId !== latestCycleId) {
      break;
    }
  }

  if (latestCycleId === null) {
    return {
      marketPaisaPerGram: null,
      source: null,
      confidence: "paused",
      degraded: true,
      overridden: false,
      cycleId: null,
      fetchedAtSeconds: epochNow(),
      providerSeconds: null,
      marketAgeSeconds: null,
      reason,
      samples: [],
    };
  }

  const cycleRows = rows.filter((r) => r.cycleId === latestCycleId);
  const selected = cycleRows.find((r) => r.selected && r.pricePaisaPerGram !== null) ??
    cycleRows.filter((r) => r.pricePaisaPerGram !== null)[0];

  if (!selected || selected.pricePaisaPerGram === null) {
    return {
      marketPaisaPerGram: null,
      source: null,
      confidence: "paused",
      degraded: true,
      overridden: false,
      cycleId: latestCycleId,
      fetchedAtSeconds: Math.floor((selected?.fetchedAt.getTime() ?? Date.now()) / 1000),
      providerSeconds: null,
      marketAgeSeconds: null,
      reason,
      samples: cycleRows.map((r) => ({
        source: r.source as SourceId,
        ok: r.pricePaisaPerGram !== null,
        pricePaisaPerGram: r.pricePaisaPerGram,
        accepted: r.accepted,
        selected: r.selected,
        reason: r.reason,
      })),
    };
  }

  const acceptedCount = cycleRows.filter((r) => r.accepted && r.pricePaisaPerGram !== null).length;
  const confidence: Confidence =
    selected.selected && acceptedCount > 1 ? "validated" : "single_source";
  const fetchedAtSeconds = Math.floor(selected.fetchedAt.getTime() / 1000);

  return {
    marketPaisaPerGram: selected.pricePaisaPerGram,
    source: selected.source as SourceId,
    confidence,
    degraded: selected.source !== "A_pakgold",
    overridden: false,
    cycleId: latestCycleId,
    fetchedAtSeconds,
    providerSeconds: null,
    marketAgeSeconds: epochNow() - fetchedAtSeconds,
    reason,
    samples: cycleRows.map((r) => ({
      source: r.source as SourceId,
      ok: r.pricePaisaPerGram !== null,
      pricePaisaPerGram: r.pricePaisaPerGram,
      accepted: r.accepted,
      selected: r.selected,
      reason: r.reason,
    })),
  };
}

/** §6.5 trading gate: paused/honest reasons come back typed, never as a blank 500. */
export function tradingGate(
  snapshot: PriceSnapshot,
  settings: SettingsLike,
): ErrorCode | null {
  if (settings.forcePaused) {
    return "TRADING_PAUSED";
  }
  if (snapshot.confidence === "paused" || snapshot.marketPaisaPerGram === null || snapshot.source === null) {
    return "PRICE_UNAVAILABLE";
  }
  const age = snapshot.marketAgeSeconds;
  if (age !== null && age > settings.maxPriceAgeSeconds) {
    return "TRADING_PAUSED";
  }
  return null;
}
