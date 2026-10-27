import { getSettings } from "../db/repo";
import { getPrice } from "./price";
import { KEY_CYCLE_CLAIM, kvSetNx } from "./redis";
import { CYCLE_CLAIM_SECONDS, CYCLE_INTERVAL_SECONDS } from "./constants";

let started = false;

/**
 * §3.2 "Fetch all three sources every 5 minutes (scheduled job)".
 *
 * Started once per process from instrumentation.ts's register() hook. On
 * serverless hosts without a long-lived process, the on-read refresh in
 * getPrice keeps the published price at most one cycle old, so the
 * same guarantee holds either way.
 */
export function startPriceScheduler(): void {
  if (started) return;
  started = true;

  const tick = async (): Promise<void> => {
    try {
      // The claim doubles as the "another fetch in flight" guard.
      const claim = await kvSetNx(KEY_CYCLE_CLAIM, Math.floor(Date.now() / 1000), CYCLE_CLAIM_SECONDS);
      if (claim !== null) {
        const settings = await getSettings();
        await getPrice(settings, true);
      }
    } catch (err) {
      // A failing cycle must never crash the process (§3.2 error handling).
      console.error("[scheduler] price tick failed:", err instanceof Error ? err.message : err);
    }
  };

  const timer = setInterval(() => void tick(), CYCLE_INTERVAL_SECONDS * 1000);
  // Never keep the process alive just for the timer.
  timer.unref?.();
  void tick();
  console.log("[scheduler] price scheduler started (every 5 minutes)");
}
