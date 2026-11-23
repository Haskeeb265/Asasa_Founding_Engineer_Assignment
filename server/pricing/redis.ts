/**
 * Upstash Redis REST helper with a process-local mirror.
 *
 * Redis is a cache only: price snapshots, the fetch claim/cooldown and the FX
 * rate. It never holds money or idempotency state. Every operation falls back
 * to the in-process Map when Redis is unset or failing, so a dead cache
 * degrades to memory instead of a fetch storm.
 */

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

type GlobalWithMemory = typeof globalThis & {
  __asasaRedisMemory?: Map<string, MemoryEntry>;
};

function memory(): Map<string, MemoryEntry> {
  const g = globalThis as GlobalWithMemory;
  if (!g.__asasaRedisMemory) g.__asasaRedisMemory = new Map();
  return g.__asasaRedisMemory;
}

function memoryGet(key: string): string | null {
  const store = memory();
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function memorySet(key: string, value: string, ttlSeconds?: number): void {
  memory().set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : Number.MAX_SAFE_INTEGER,
  });
}

function memoryDel(key: string): void {
  memory().delete(key);
}

function redisConfig(): { url: string; token: string } | null {
  // Accept the plain Upstash names and the names injected by Vercel's
  // Upstash integration (which prefixes the KV_REST_API_* variables).
  const url =
    process.env.UPSTASH_REDIS_REST_URL ??
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ??
    process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ??
    process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

async function rest(command: (string | number)[]): Promise<{ ok: boolean; result: unknown }> {
  const config = redisConfig();
  if (!config) return { ok: false, result: null };

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { ok: false, result: null };
    const data = (await response.json()) as { result?: unknown };
    return { ok: true, result: data.result ?? null };
  } catch {
    return { ok: false, result: null };
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  const remote = await rest(['GET', key]);
  if (remote.ok) {
    if (typeof remote.result === 'string') {
      memorySet(key, remote.result);
      return remote.result;
    }
    memoryDel(key);
    return null;
  }
  return memoryGet(key);
}

export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds?: number,
): Promise<void> {
  memorySet(key, value, ttlSeconds);
  if (ttlSeconds) {
    await rest(['SET', key, value, 'EX', ttlSeconds]);
  } else {
    await rest(['SET', key, value]);
  }
}

export async function cacheDel(key: string): Promise<void> {
  memoryDel(key);
  await rest(['DEL', key]);
}

/**
 * SET NX EX. Returns true only to the caller that acquired the claim.
 * With no Redis configured the in-process Map is the whole world.
 */
export async function cacheSetNx(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<boolean> {
  const config = redisConfig();
  if (!config) {
    if (memoryGet(key) !== null) return false;
    memorySet(key, value, ttlSeconds);
    return true;
  }

  const remote = await rest(['SET', key, value, 'NX', 'EX', ttlSeconds]);
  if (!remote.ok) {
    if (memoryGet(key) !== null) return false;
    memorySet(key, value, ttlSeconds);
    return true;
  }
  if (remote.result === null) return false;
  memorySet(key, value, ttlSeconds);
  return true;
}
