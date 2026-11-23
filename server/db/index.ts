import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

type GlobalWithDb = typeof globalThis & {
  __asasaPool?: Pool;
  __asasaDrizzle?: ReturnType<typeof drizzle>;
};

/**
 * Neon's pooled connection string is transaction-mode: no advisory locks and no
 * session state. A small cached pool is enough for this single-user demo.
 */
export function getPool(): Pool {
  const g = globalThis as GlobalWithDb;
  if (g.__asasaPool) return g.__asasaPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Configure the Neon pooled connection string in .env.local.',
    );
  }

  const pool = new Pool({ connectionString, max: 5 });
  pool.on('error', (error) => {
    console.error('Postgres pool error:', error.message);
  });
  g.__asasaPool = pool;
  return pool;
}

export function getDb() {
  const g = globalThis as GlobalWithDb;
  if (!g.__asasaDrizzle) g.__asasaDrizzle = drizzle(getPool());
  return g.__asasaDrizzle;
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the useful one.
    }
    throw error;
  } finally {
    client.release();
  }
}
