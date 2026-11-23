import { sweepQuotes } from '../db/repo';
import {
  SCHEDULER_INTERVAL_SECONDS,
  SCHEDULER_LOCK_KEY,
  SCHEDULER_LOCK_SECONDS,
} from './constants';
import { forceCycle } from './price';
import { cacheSetNx } from './redis';

type GlobalWithScheduler = typeof globalThis & {
  __asasaSchedulerStarted?: boolean;
};

async function tick(): Promise<void> {
  const acquired = await cacheSetNx(
    SCHEDULER_LOCK_KEY,
    String(Date.now()),
    SCHEDULER_LOCK_SECONDS,
  );
  if (!acquired) return;

  try {
    await sweepQuotes();
  } catch (error) {
    console.error(
      'Scheduler sweep failed:',
      error instanceof Error ? error.message : error,
    );
  }

  try {
    await forceCycle();
  } catch (error) {
    console.error(
      'Scheduler price cycle failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Best-effort on serverless: Vercel Hobby has no reliable 5-minute cron, so the
 * read path (sweep on /api/state, lazy fetch) is the actual guarantee.
 */
export function startScheduler(): void {
  const g = globalThis as GlobalWithScheduler;
  if (g.__asasaSchedulerStarted) return;
  g.__asasaSchedulerStarted = true;

  const timer = setInterval(() => {
    void tick();
  }, SCHEDULER_INTERVAL_SECONDS * 1000);
  timer.unref?.();

  void tick();
}
