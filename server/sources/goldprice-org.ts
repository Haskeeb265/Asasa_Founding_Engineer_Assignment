import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
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
 *
 * Unset (empty), the mode is inferred: "remote" on Vercel (VERCEL=1 is injected
 * into every Vercel function and the Python function ships with the project),
 * "disabled" anywhere else. A dashboard env var is therefore not required.
 */
export function goldpriceFetchMode(): "python" | "remote" | "disabled" {
  const raw = (process.env.GOLDPRICE_FETCH_MODE || "").trim().toLowerCase();
  if (raw === "python" || raw === "remote" || raw === "disabled") return raw;
  return process.env.VERCEL ? "remote" : "disabled";
}

export function isGoldpriceEnabled(): boolean {
  return goldpriceFetchMode() !== "disabled";
}

function remoteGoldpriceUrl(): string | null {
  if (process.env.GOLDPRICE_REMOTE_URL) return process.env.GOLDPRICE_REMOTE_URL;
  // Vercel injects both the deployment URL (VERCEL_URL) and the stable
  // production domain (VERCEL_PROJECT_PRODUCTION_URL) into every function.
  // The production domain is preferred: requests to the per-deployment URL
  // from inside a function have been observed returning the app router's 404
  // HTML (`<!DOCTYPE…`) for the sibling Python function's /api/* path, while
  // the same endpoint answers JSON when fetched from outside (curl / a
  // browser). External hosts resolve this URL through public DNS and the
  // request reaches the function like any browser's would.
  const prodUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prodUrl) return `https://${prodUrl}/api/goldprice`;
  const vercelUrl = process.env.VERCEL_URL;
  return vercelUrl ? `https://${vercelUrl}/api/goldprice` : null;
}

/**
 * Raw HTTPS GET over the node:https module — deliberately NOT the global
 * `fetch`, which Vercel interposes inside functions and through which calls to
 * the project's own domain have been observed resolving internally to the
 * calling function's route table (yielding its 404 HTML instead of the Python
 * sibling's JSON). A plain socket request follows the same path as the curl
 * that verifies the endpoint from outside. Returns the full first response:
 * no redirect-following, so the status and headers stay observable.
 */
function httpsGetRaw(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; contentType: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "user-agent": "asasa-gold-demo/1.0",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("error", reject);
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: (res.headers["content-type"] as string | undefined) ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("remote goldprice fetch timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** Diagnosable description of a non-JSON answer: status, content type, body head. */
function nonJsonReason(status: number, contentType: string | null, body: string): string {
  const head = body.trim().slice(0, 40).replace(/\s+/g, " ");
  return `remote goldprice endpoint returned HTTP ${status} ${contentType ?? "(no content-type)"} — body starts '${head}'`;
}

export const GOLDPRICE_UNAVAILABLE_REASON =
  "GoldPrice.org — unavailable from this host (WAF blocks non-browser TLS fingerprints)";

/** Same result envelope as the python leg: {ok:true,pkr_per_oz,date}|{ok:false,error}. */
async function fetchGoldpriceRemote(): Promise<SourceResult> {
  const url = remoteGoldpriceUrl();
  if (!url) {
    return {
      ok: false,
      reason: "GoldPrice.org — remote fetch selected but no GOLDPRICE_REMOTE_URL/VERCEL_URL is set",
    };
  }

  let status = 0;
  let contentType: string | null = null;
  let body = "";
  try {
    ({ status, contentType, body } = await httpsGetRaw(url, REMOTE_TIMEOUT_MS));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `remote goldprice endpoint ${url} failed: ${message}` };
  }

  if (status >= 400) {
    return { ok: false, reason: nonJsonReason(status, contentType, body) };
  }

  let parsed: { ok?: boolean; error?: string; pkr_per_oz?: number; date?: string };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    // The user-facing failure reason, so the live data table shows exactly what
    // the function answered instead of a bare "Unexpected token '<'" parse error.
    return { ok: false, reason: nonJsonReason(status, contentType, body) };
  }
  return goldpriceQuoteFromPayload(parsed);
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
  const mode = goldpriceFetchMode();
  if (mode === "disabled") {
    return { ok: false, reason: GOLDPRICE_UNAVAILABLE_REASON };
  }

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
