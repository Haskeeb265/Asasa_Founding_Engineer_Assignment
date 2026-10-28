/** Structural settings shape pricing needs; the live row lives in server/db/repo.ts. */
export interface SettingsLike {
  guardrailPaisaPerGram: bigint;
  quoteTtlSeconds: number;
  divergenceThresholdBps: number;
  maxPriceAgeSeconds: number;
  /** Seconds a fetched price stays fresh before the cycle refetches (§6.3 TTL). */
  priceFetchIntervalSeconds: number;
  sourceAOn: boolean;
  sourceBOn: boolean;
  sourceCOn: boolean;
  sourceCBasisBps: number;
  priceOverridePaisa: bigint | null;
  forcePaused: boolean;
}
