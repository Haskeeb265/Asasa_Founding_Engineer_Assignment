import { Redis } from "@upstash/redis";

/**
 * Redis does exactly three jobs, never money:
 *   price:current        — hot price read (TTL = the fetch interval)
 *   price:next_fetch_at  — fetch cooldown, set on success AND failure
 *   fx:usd_pkr           — the FX leg cache (TTL 6 h; er-api updates ~daily)
 *
 * Without credentials (unit-test runs, fresh clone) everything below degrades
 * to no-ops: pricing still works through the Postgres `prices` record, just
 * less cached and slightly chattier towards the sources.
 *
 * WITH credentials but a dead endpoint (network outage, DNS failure — both
 * observed on this host), the REST client can resolve calls to null/undefined
 * instead of throwing. Left alone that silently breaks the freshness cache,
 * so every /api/state poll runs a whole new pricing cycle — the "fetched 0s
 * ago forever" bug. Two defences, both local-only and safe for this
 * single-user demo:
 *   1. every successful local operation mirrors into a process-local map;
 *   2. when Upstash answers with nothing that a healthy Redis could produce
 *      (silently nullish calls, NX ignored), the store is flagged unreachable
 *      for a short while and the mirrors serve instead.
 * The mirror is per-process: on a serverless platform with many instances it
 * is weaker than Redis (claims could double-fire across instances), but it is
 * strictly better than "every read is a fetch storm".
 */

let client: Redis | undefined;

export function getRedis(): Redis | undefined {
  if (client) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return undefined;
  client = new Redis({ url, token });
  return client;
}

export const KEY_CURRENT = "price:current";
export const KEY_NEXT_FETCH_AT = "price:next_fetch_at";
/** In-flight cycle claim, doubling as the "another fetch is running" guard. */
export const KEY_CYCLE_CLAIM = "price:cycle_claim";
export const KEY_FX = "fx:usd_pkr";

const OUTAGE_RETRY_MS = 60_000;
let outageUntil = 0;

function markOutage(): void {
  if (Date.now() >= outageUntil) {
    console.error(
      "[redis] Upstash is unreachable — the price cache/cooldown falls back to process-local memory and re-probes every minute.",
    );
  }
  outageUntil = Date.now() + OUTAGE_RETRY_MS;
}

const redisHealthy = (): boolean => Date.now() >= outageUntil;

interface LocalEntry {
  value: unknown;
  expiresAt: number;
}
const localStore = new Map<string, LocalEntry>();

const localGet = (key: string): unknown | null | undefined => {
  const entry = localStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    localStore.delete(key);
    return null;
  }
  return entry.value;
};

const localSet = (key: string, value: unknown, ttlSeconds: number): void => {
  localStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
};

function localSetNx(key: string, value: unknown, ttlSeconds: number): unknown {
  const existing = localGet(key);
  if (existing !== null && existing !== undefined) return null; // held by someone else
  localSet(key, value, ttlSeconds);
  return value;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (redis && redisHealthy()) {
    try {
      const value = await redis.get<T>(key);
      if (value === undefined) {
        // undefined is not "missing": the call itself failed silently.
        markOutage();
      } else if (value !== null) {
        return value;
      } else {
        const mirror = localGet(key);
        if (mirror !== null && mirror !== undefined) {
          // A healthy Redis should still hold what we wrote recently; a
          // freshly-written key reading null means the endpoint is lying.
          markOutage();
          return mirror as T;
        }
        return null;
      }
    } catch {
      markOutage();
    }
  }
  const mirror = localGet(key);
  return (mirror ?? null) as T | null;
}

export async function kvSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (redis && redisHealthy()) {
    try {
      const result = await redis.set(key, value, { ex: ttlSeconds });
      if (result === null || result === undefined) {
        // A healthy SET answers "OK"; anything nullish failed the call.
        markOutage();
      } else {
        // Keep the mirror warm even when Redis is healthy.
        localSet(key, value, ttlSeconds);
        return;
      }
    } catch {
      markOutage();
    }
  }
  localSet(key, value, ttlSeconds);
}

/** Sets the key only if it does not exist; returns the stored value. */
export async function kvSetNx(key: string, value: unknown, ttlSeconds: number): Promise<unknown> {
  const redis = getRedis();
  if (redis && redisHealthy()) {
    try {
      const result = await redis.set(key, value, { nx: true, ex: ttlSeconds });
      if (result === "OK") return result; // claim acquired remotely
      if (result === null || result === undefined) return result; // key already held
      // Anything else (e.g. the echoed value) is what an endpoint with a
      // broken NX returns — treat the answer as unreliable and fall back.
      markOutage();
    } catch {
      markOutage();
    }
  }
  return localSetNx(key, value, ttlSeconds);
}

export async function kvDelete(key: string): Promise<void> {
  const redis = getRedis();
  localStore.delete(key);
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    console.error(`[redis] del ${key} failed:`, err instanceof Error ? err.message : err);
  }
}
