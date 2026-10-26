export type SourceId = "A_pakgold" | "B_goldprice" | "C_yahoo";

export interface SourceQuote {
  source: SourceId;
  paisaPerGram: bigint;
  /**
   * The provider's own market clock, epoch seconds, when it is a real trade
   * moment (C's regularMarketTime). null when the provider only offers a
   * ticking response timestamp (A) that would fake freshness (§6.6).
   */
  providerSeconds: number | null;
  /** Trimmed provider payload kept for the per-cycle explainability panel. */
  raw: Record<string, unknown>;
}

export type SourceResult = { ok: true; quote: SourceQuote } | { ok: false; reason: string };

export async function fetchJson(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}${new URL(url).pathname}`);
  }
  return res.json();
}

export const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
