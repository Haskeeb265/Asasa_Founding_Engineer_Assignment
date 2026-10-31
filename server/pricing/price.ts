import { db } from "../db";
import { prices } from "../db/schema";
import { desc } from "drizzle-orm";
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

const PRICE_TTL_SECONDS_FALLBACK = 300;
const FETCH_WINDOW_SECONDS = 20;
const FAILURE_BACKOFF_SECONDS = 60;

/**
 * §6.3 TTL now lives in the settings table (the operator's "fetch interval"):
 * how long a fetched price stays fresh before the next eligible request spins
 * a new cycle. Clamped against a broken/low value so the sources can never be
 * hammered by a misconfigured dial.
 */
function fetchIntervalSeconds(settings: SettingsLike): number {
  const v = settings.priceFetchIntervalSeconds;
  return Number.isFinite(v) ? Math.min(86_400, Math.max(1, Math.floor(v))) : PRICE_TTL_SECONDS_FALLBACK;
}

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
  /** now - max(usable provider stamps); null = unknown, never fake it. Display info only. */
  marketAgeSeconds: number | null;
  /** now - fetchedAtSeconds: how old the producing cycle is. This is what the
   * §3.7 staleness gate checks — a provider's own market clock lagging is a
   * source-status concern (STALE), not a global trading halt. */
  fetchAgeSeconds: number;
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
    fetchAgeSeconds: age,
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
      fetchAgeSeconds: 0,
      reason: "demo price override active (not a market price)",
      samples: [],
    };
  }
  const cached = await kvGet<CacheShape>(KEY_CURRENT);
  if (!cached) return snapshotFromDb(settings, "no cached price yet");
  if (epochNow() - cached.fetchedAtSeconds > fetchIntervalSeconds(settings)) {
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
      fetchAgeSeconds: 0,
      reason: "demo price override active (not a market price)",
      samples: [],
    };
  }

  if (!force) {
    const cached = await kvGet<CacheShape>(KEY_CURRENT);
    if (cached && epochNow() - cached.fetchedAtSeconds <= fetchIntervalSeconds(settings)) {
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
    await kvSet(KEY_CURRENT, cacheValue, fetchIntervalSeconds(settings));

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
      fetchAgeSeconds: epochNow() - cycle.fetchedAtSeconds,
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
  // DESCENDING: the last 60 rows. (A previous ASCENDING + limit(60) read the
  // 60 oldest rows ever, which made "last recorded cycle" mean "Oct 24" and
  // served hours-old prices whenever the durable fallback was consulted.)
  const rows = await db.select().from(prices).orderBy(desc(prices.fetchedAt)).limit(60);

  // The latest cycle = the leading run of identical consecutive cycleIds 
  // (rows arrive newest-first).
  let latestCycleId: string | null = null;
  for (const row of rows) {
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
      fetchAgeSeconds: 0,
      reason,
      samples: [],
    };
  }

  const cycleRows = [...rows.filter((r) => r.cycleId === latestCycleId)].reverse(); // newest-first -> oldest-first
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
      fetchAgeSeconds: 0,
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
    fetchAgeSeconds: epochNow() - fetchedAtSeconds,
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

/**
 * The gate's verdict: ok, or a typed refusal carrying the user-facing copy so
 * every route (and the UI notice) says exactly the same thing.
 */
export type TradeGateVerdict =
  | { ok: true }
  | {
      ok: false;
      code: ErrorCode;
      message: string;
      hint: string | undefined;
    };

const NO_PRICE_MESSAGE =
  "Prices cannot be validated right now. Please try again in 5 minutes.";

const UNRELIABLE_MESSAGE =
  "The price is unreliable and cannot be validated right now — please try again later.";

const NO_SOURCE_MESSAGE =
  "There is no price available right now. No price source is reporting, so trading is paused — please try again later.";

function graceWindowRefusal(
  snapshot: PriceSnapshot,
  settings: SettingsLike,
  insufficientSource: SourceId | null,
  insufficientCount: number,
): TradeGateVerdict {
  const named =
    insufficientSource === null
      ? "no price source"
      : SOURCE_LABEL[insufficientSource];
  const message =
    insufficientCount === 0
      ? NO_SOURCE_MESSAGE
      : UNRELIABLE_MESSAGE;
  return {
    ok: false,
    code: "PRICE_UNAVAILABLE",
    message,
    hint: `Price was fetched ${snapshot.fetchAgeSeconds} s ago and is still within the ${settings.maxPriceAgeSeconds}s limit, so the last valid price is still shown; trading pauses once it ages out. Right now only ${named} is available for the next fetch.`,
  };
}

function staleHint(snapshot: PriceSnapshot, settings: SettingsLike): string {
  return `Price updated ${snapshot.fetchAgeSeconds} s ago (max ${settings.maxPriceAgeSeconds} s) — ${snapshot.reason ?? "every source failed this cycle"}`;
}

function noPrice(snapshot: PriceSnapshot, settings: SettingsLike): TradeGateVerdict {
  return { ok: false, code: "PRICE_UNAVAILABLE", message: NO_PRICE_MESSAGE, hint: staleHint(snapshot, settings) };
}

const SOURCE_LABEL: Record<SourceId, string> = {
  A_pakgold: "PakGold.pk",
  B_goldprice: "GoldPrice.org",
  C_yahoo: "Yahoo",
};

/**
 * The sources that are BOTH switched on and reporting an accepted price in the
 * snapshot: availability is what actually answered, not merely a toggle.
 * A demo price override stands in for the trust anchor (PakGold.pk).
 */
function availableSources(snapshot: PriceSnapshot, settings: SettingsLike): SourceId[] {
  if (snapshot.overridden) return ["A_pakgold"];
  const enabled: Record<SourceId, boolean> = {
    A_pakgold: settings.sourceAOn,
    B_goldprice: settings.sourceBOn,
    C_yahoo: settings.sourceCOn,
  };
  const seen = new Set<SourceId>();
  for (const sample of snapshot.samples) {
    if (sample.accepted && sample.pricePaisaPerGram !== null && enabled[sample.source]) {
      seen.add(sample.source);
    }
  }
  return [...seen];
}

/**
 * §6.5 trading gate.
 *
 * Source-availability rule (the one you described): trading continues when the
 * sources that actually reported an accepted price PLUS are switched on number at
 * least two — i.e. 2 or 3 of {A_pakgold, B_goldprice, C_yahoo}. The only case
 * that is refused is a single available source of any kind, including PakGold.pk
 * alone. (That is the rule you specified; the earlier special-casing of A alone
 * is removed here.)
 *
 * Grace window: the availability rules above do NOT apply the instant the
 * current sources become insufficient. They only apply once the currently held
 * price has aged past maxPriceAgeSeconds. Before that, the price the last
 * successful cycle fetched is still shown and tradeable, even if the sources are
 * currently off/insufficient — because the price was valid when it was fetched.
 * After the age limit lapses, the same rule decides whether the next fetch can
 * produce a usable price; until then, the old price keeps trading.
 *
 * A fresh but insufficient-source verdict is therefore delayed: it is reported as
 * PRICE_UNAVAILABLE with the usual "try again later" copy only once the price is
 * also stale. Before staleness, the refusal body is the grace-window copy and the
 * hint names the insufficient live set.
 *
 * If there is no price at all (never fetched, or every cycle failed with no
 * selected price), the gate never defers — there is no last valid price to keep
 * trading on, so the refusal is immediate.
 */
export function tradingGate(
  snapshot: PriceSnapshot,
  settings: SettingsLike,
): TradeGateVerdict {
  if (settings.forcePaused) {
    return {
      ok: false,
      code: "TRADING_PAUSED",
      message: "Trading is paused right now.",
      hint: "The force-paused toggle is on.",
    };
  }
  if (snapshot.confidence === "paused" || snapshot.marketPaisaPerGram === null || snapshot.source === null) {
    return noPrice(snapshot, settings);
  }

  const available = availableSources(snapshot, settings);
  const insufficientNow = available.length < 2;
  // The one case the rule ever refuses on.
  const insufficientSource: SourceId | null = (insufficientNow && available.length === 1 ? available[0] : null) ?? null;

  // Grace window: the currently held price was valid when fetched, so keep
  // trading on it until it ages out. While it is still within maxPriceAgeSeconds,
  // an insufficient live source set does NOT yet refuse — the refusal is deferred
  // until the age limit lapses. Once stale, the same insufficient-set rule decides
  // whether trading can continue at all.
  if (insufficientNow && snapshot.fetchAgeSeconds <= settings.maxPriceAgeSeconds) {
    return graceWindowRefusal(snapshot, settings, insufficientSource, available.length);
  }

  if (insufficientNow) {
    if (available.length === 0) {
      return {
        ok: false,
        code: "PRICE_UNAVAILABLE",
        message: NO_SOURCE_MESSAGE,
        hint: `Price updated ${snapshot.fetchAgeSeconds} s ago (max ${settings.maxPriceAgeSeconds} s) — no source is reporting, so the next fetch cannot produce a validated price.`,
      };
    }
    return {
      ok: false,
      code: "PRICE_UNAVAILABLE",
      message: UNRELIABLE_MESSAGE,
      hint: `Only ${SOURCE_LABEL[insufficientSource!]} is reporting a price, so there is no second source to validate it against (price updated ${snapshot.fetchAgeSeconds} s ago, max ${settings.maxPriceAgeSeconds} s).`,
    };
  }

  // 2+ available sources: trading continues on the price itself, and only the
  // plain staleness rule can still refuse it.
  if (snapshot.fetchAgeSeconds > settings.maxPriceAgeSeconds) {
    return noPrice(snapshot, settings);
  }
  return { ok: true };
}
