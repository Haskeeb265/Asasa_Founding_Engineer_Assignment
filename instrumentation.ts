/**
 * §3.2 — the scheduled fetch job. Next runs register() once per server
 * process; the price scheduler then refreshes the current price every
 * 5 minutes. Serverless-only hosts fall back to the on-read refresh.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPriceScheduler } = await import("./server/pricing/scheduler");
    startPriceScheduler();
  }
}
