/** Seed values, reused verbatim by POST /api/demo/reset. */
export const SEED_BALANCES = [
  { key: 'pkr', unit: 'paisa', amount: 50_000_000n }, // Rs 500,000.00
  { key: 'user_gold', unit: 'microgram', amount: 20_000_000n }, // 20 g
  { key: 'platform_gold', unit: 'microgram', amount: 100_000_000n }, // 100 g
] as const;

export const TOTAL_GOLD_UG = 120_000_000n;
