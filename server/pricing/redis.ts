import { Redis } from "@upstash/redis";

/**
 * Redis does exactly three jobs, never money:
 *   price:current        — hot price read (TTL 300 s)
 *   price:next_fetch_at  — fetch cooldown, set on success AND failure
 *   fx:usd_pkr           — the FX leg cache (TTL 6 h; er-api updates ~daily)
 *
 * Without credentials (unit-test runs, fresh clone) everything below degrades
 * to no-ops: pricing still works through the Postgres `prices` record, just
 * less cached and slightly chattier towards the sources.
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
export const KEY_FX = "fx:usd_pkr";

export async function kvGet<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get<T>(key);
    return value ?? null;
  } catch (err) {
    console.error(`[redis] get ${key} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function kvSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.error(`[redis] set ${key} failed:`, err instanceof Error ? err.message : err);
  }
}

/** Sets the key only if it does not exist; returns the stored value. */
export async function kvSetNx(key: string, value: unknown, ttlSeconds: number): Promise<unknown> {
  const redis = getRedis();
  if (!redis) {
    // No Redis = no contention to guard against; claim always succeeds.
    return value;
  }
  try {
    const result = await redis.set(key, value, { nx: true, ex: ttlSeconds });
    return result;
  } catch (err) {
    console.error(`[redis] setnx ${key} failed:`, err instanceof Error ? err.message : err);
    // Fail open would re-fetch on every read; fail closed serves stale instead.
    return null;
  }
}

export async function kvDelete(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    console.error(`[redis] del ${key} failed:`, err instanceof Error ? err.message : err);
  }
}
