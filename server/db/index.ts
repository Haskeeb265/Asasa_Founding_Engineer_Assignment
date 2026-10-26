import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const REQUIRED_URL = "DATABASE_URL is not set. Copy .env.example to .env and fill in the Neon POOLED connection string.";

let poolSingleton: Pool | undefined;

/** One pool per process, reused across Next's hot reloads. */
export function getPool(): Pool {
  if (poolSingleton) return poolSingleton;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(REQUIRED_URL);
  }

  poolSingleton = new Pool({
    connectionString: url,
    // Small pool: single-user demo.
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return poolSingleton;
}

const dbSingleton = drizzle(getPool(), { schema });
export { dbSingleton as db };

/** The exact transaction handle drizzle hands back from `.transaction`. */
export type Db = typeof dbSingleton;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Every write that must be all-or-nothing (settlement) runs in here.
 * READ COMMITTED stays Postgres's default and is exactly what the
 * conditional-UPDATE idempotency mechanism assumes — do not raise it.
 */
export async function runInTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return dbSingleton.transaction(async (tx) => fn(tx));
}

export { schema };
