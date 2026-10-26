/** The refresh cadence (§3.2): all sources every 5 minutes. */
export const CYCLE_INTERVAL_SECONDS = 300;
/**
 * Maximum price age (§3.7 staleness): a validated price may be used for at
 * most 6 minutes — the 5-minute cycle plus 1 minute grace. A cycle that
 * completes but fails validation invalidates the previous price immediately.
 */
export const MAX_PRICE_AGE_SECONDS = 360;
/** In-flight cycle claim TTL, so parallel reads never double-fetch. */
export const CYCLE_CLAIM_SECONDS = 60;
/** FX leg cache: er-api updates ~daily. */
export const FX_TTL_SECONDS = 6 * 60 * 60;
/** GC=F is a futures contract: this measured basis turns it into a spot-equivalent. */
export const SOURCE_C_BASIS_BPS = 28;
