import type { SourceId } from '../../domain/quorum';

export type { SourceId };

export type Sample =
  | {
      source: SourceId;
      ok: true;
      paisaPerGram: bigint;
      providerAt: Date | null;
      note?: string;
    }
  | { source: SourceId; ok: false; reason: string };

export function failure(source: SourceId, reason: string): Sample {
  return { source, ok: false, reason };
}

/** Short, safe description of a fetch failure for the prices.reason column. */
export function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 'timeout';
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message || 'fetch failed';
  }
  return 'fetch failed';
}
