import { Pool } from 'pg';
import { requireDatabaseUrl } from './env';
import { SEED_BALANCES } from '../server/db/seed-values';

async function main() {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const balance of SEED_BALANCES) {
      await client.query(
        `insert into balances (key, unit, amount, updated_at)
         values ($1, $2, $3, now())
         on conflict (key) do nothing`,
        [balance.key, balance.unit, balance.amount.toString()],
      );
    }
    await client.query(
      `insert into settings (id) values (true) on conflict (id) do nothing`,
    );
    await client.query('COMMIT');
    console.log('Seed complete: 3 balances, 1 settings row.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
