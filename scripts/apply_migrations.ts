/**
 * Applies every drizzle/*.sql migration in name order, exactly once,
 * tracked in a local demo_migrations table. Plain SQL, no drizzle-kit:
 * `drizzle-kit migrate` exits 1 silently against this project, so the
 * reviewer path is this script.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --drop  first drop the demo tables (resets data)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { loadDotEnv } from "./env";

loadDotEnv();

const DROP_LIST = [
  "demo_migrations",
  "receipts",
  "quotes",
  "trades",
  "prices",
  "price_snapshots",
  "current_price",
  "accounts",
  "balances",
  "settings",
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    console.error("DATABASE_URL is not set; nothing to do.");
    process.exit(1);
  }
  const fresh = process.argv.includes("--drop");
  const pool = new Pool({ connectionString: url, max: 1 });

  try {
    if (fresh) {
      await pool.query(
        `DROP TABLE IF EXISTS ${DROP_LIST.join(", ")} CASCADE`,
      );
      console.log(`[migrate] dropped demo tables: ${DROP_LIST.join(", ")}`);
    }

    await pool.query(
      "CREATE TABLE IF NOT EXISTS demo_migrations (name text primary key, applied_at timestamptz not null default now())",
    );

    const { rows } = await pool.query<{ name: string }>("SELECT name FROM demo_migrations");
    const applied = new Set(rows.map((r) => r.name));

    const files = readdirSync("drizzle")
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] skip (already applied): ${file}`);
        continue;
      }
      const sql = readFileSync(join("drizzle", file), "utf8");
      const statements = sql.split("--> statement-breakpoint").filter((s) => s.trim() !== "");
      await pool.query("BEGIN");
      try {
        for (const statement of statements) {
          await pool.query(statement);
        }
        await pool.query("INSERT INTO demo_migrations (name) VALUES ($1)", [file]);
        await pool.query("COMMIT");
        ran += 1;
        console.log(`[migrate] applied: ${file} (${statements.length} statements)`);
      } catch (err) {
        await pool.query("ROLLBACK");
        throw err;
      }
    }

    console.log(`[migrate] done, ${ran} migration(s) applied.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
