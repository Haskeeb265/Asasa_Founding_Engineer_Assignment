import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { requireDatabaseUrl } from './env';

async function main() {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: 'drizzle' });
    console.log('Migrations applied.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
