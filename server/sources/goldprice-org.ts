import { spawn } from "node:child_process";
import { marketPaisaPerGramFromPkrPerOz } from "../../domain/units";
import type { SourceId, SourceResult } from "./types";

const SOURCE: SourceId = "B_goldprice";
const PY_TIMEOUT_MS = 20_000;
const REMOTE_TIMEOUT_MS = 20_000;

/**
 * Source B — the brief's named fallback. Reachable only through a TLS-fingerprint
 * browser client (curl_cffi), so the fetch runs on a Python host:
 *
 * GOLDPRICE_FETCH_MODE:
 *   "python"  (local dev)  — spawn scripts/fetch_goldprice.py (curl_cffi locally)
 *   "remote"  (Vercel)     — GET the deployed Python function (api/goldprice.py),
 *                            which runs curl_cffi on the Python runtime; Vercel's
 *                            Node image has no Python, so it cannot do "python"
 *   "disabled" (tests)     — skip; quota reports the documented gap
 * Plus invisible degrading to skipped.
 */
export function isGoldpriceEnabled(): boolean {
  const mode = (process.env.GOLDPRICE_FETCH_MODE || "disabled").toLowerCase();
  return mode === "python" || mode === "remote";
}

function remoteGoldpriceUrl(): string | null {
  if (process.env.GOLDPRICE_REMOTE_URL) return process.env.GOLDPRICE_REMOTE_URL;
  // VERCEL_URL is injected into every Vercel function (host without scheme).
  const vercelUrl = process.env.VERCEL_URL;
  return vercelUrl ? `https://${vercelUrl}/api/goldprice` : null;
}

export const GOLDPRICE_UNAVAILABLE_REASON =
  "GoldPrice.org — unavailable from this host (WAF blocks non-browser TLS fingerprints)";

/** Same result envelope as the python leg: {ok:true,pkr_per_oz,date}|{ok:false,error}. */
async function fetchGoldpriceRemote(): Promise<SourceResult> {
  const url = remoteGoldpriceUrl();
  if (!url) {
    return {
      ok: false,
      reason: "GOLDPRICE_FETCH_MODE=remote but no GOLDPRICE_REMOTE_URL/VERCEL_URL is set",
    };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: `remote goldprice function returned HTTP ${res.status}` };
    const parsed = (await res.json()) as { ok?: boolean; error?: string; pkr_per_oz?: number; date?: string };
    return goldpriceQuoteFromPayload(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message };
  }
}

function goldpriceQuoteFromPayload(parsed: {
  ok?: boolean;
  error?: string;
  pkr_per_oz?: number;
  date?: string;
}): SourceResult {
  if (parsed.ok !== true || typeof parsed.pkr_per_oz !== "number" || parsed.pkr_per_oz <= 0) {
    return { ok: false, reason: parsed.error || "goldprice leg reported failure" };
  }

  // its `date` is a real provider moment; keep it when it parses cleanly
  let providerSeconds: number | null = null;
  if (parsed.date) {
    const parsedSeconds = Date.parse(parsed.date) / 1000;
    providerSeconds = Number.isFinite(parsedSeconds) ? Math.round(parsedSeconds) : null;
  }

  return {
    ok: true,
    quote: {
      source: SOURCE,
      paisaPerGram: marketPaisaPerGramFromPkrPerOz(parsed.pkr_per_oz),
      providerSeconds,
      raw: { pkr_per_oz: parsed.pkr_per_oz, date: parsed.date ?? null },
    },
  };
}

export async function fetchGoldpriceOrg(): Promise<SourceResult> {
  if (!isGoldpriceEnabled()) {
    return { ok: false, reason: GOLDPRICE_UNAVAILABLE_REASON };
  }

  const mode = (process.env.GOLDPRICE_FETCH_MODE || "disabled").toLowerCase();
  if (mode === "remote") return await fetchGoldpriceRemote();

  const pythonBin = process.env.PYTHON_BIN || "python";

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(pythonBin, ["scripts/fetch_goldprice.py"], { cwd: process.cwd() });
      let out = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("python fetch timed out"));
      }, PY_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        out += ""; // stderr is noise; failures are reported through exit paths
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`python exited with code ${code}: ${out.trim().slice(0, 200)}`));
      });
    });

    const line = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .pop();
    if (!line) return { ok: false, reason: "python leg printed no JSON" };

    return goldpriceQuoteFromPayload(JSON.parse(line) as { ok?: boolean; error?: string; pkr_per_oz?: number; date?: string });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message };
  }
}
