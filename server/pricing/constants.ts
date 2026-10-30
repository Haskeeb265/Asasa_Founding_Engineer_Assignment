/** The refresh cadence (§3.2): all sources every 5 minutes. */
export const CYCLE_INTERVAL_SECONDS = 300;
/** In-flight cycle claim TTL, so parallel reads never double-fetch. */
export const CYCLE_CLAIM_SECONDS = 60;
/** FX leg cache: er-api updates ~daily. */
export const FX_TTL_SECONDS = 6 * 60 * 60;
