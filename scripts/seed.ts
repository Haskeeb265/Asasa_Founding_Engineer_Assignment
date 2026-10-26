/**
 * Seed = the demo's initial truth, idempotently.
 *   pkr            50,000,000 paisa  (Rs 500,000.00 — buys ~12 g)
 *   user_gold      20,000,000 µg     (20 g — fully liquidatable inside the Rs 1M cap)
 *   platform_gold  100,000,000 µg    (100 g — total gold stays 120 g, forever)
 * plus the singleton settings row. The demo reset reuses the same numbers,
 * so they live here and in server/db/repo.ts (shared via DEMO_SEED below).
 *
 * Idempotent: ON CONFLICT DO NOTHING, so re-running never moves money.
 */
import { loadDotEnv } from "./env";

loadDotEnv();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill in the Neon POOLED string.");
  process.exit(1);
}

import { getPool, runInTransaction } from "../server/db";
import { balances, settings } from "../server/db/schema";
import { PAISA_PER_PKR } from "../domain/units";
import { sql } from "drizzle-orm";

export const DEMO_SEED = {
  pkrPaisa: 50_000_000n,
  userGoldMicrograms: 20_000_000n,
  platformGoldMicrograms: 100_000_000n,
} as const;

export async function seedDemo(): Promise<void> {
  const pool = getPool();
  await runInTransaction(async (tx) => {
    await tx
      .insert(balances)
      .values([
        { key: "pkr", unit: "paisa", amount: DEMO_SEED.pkrPaisa },
        { key: "user_gold", unit: "microgram", amount: DEMO_SEED.userGoldMicrograms },
        { key: "platform_gold", unit: "microgram", amount: DEMO_SEED.platformGoldMicrograms },
      ])
      .onConflictDoNothing();
    await tx.insert(settings).values({}).onConflictDoNothing();
  });
  await pool.end();
}

seedDemo()
  .then(() => {
    console.log(
      "Seeded (no-op if already present):",
      `${Number(DEMO_SEED.pkrPaisa) / Number(PAISA_PER_PKR)} PKR,`,
      `${Number(DEMO_SEED.userGoldMicrograms) / 1e6} g user,`,
      `${Number(DEMO_SEED.platformGoldMicrograms) / 1e6} g platform,`,
      "settings row ensured.",
    );
  })
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
