import { execFile } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';
import { ingestPkrPerTroyOz } from '../../domain/units';
import { describeFetchError, failure, type Sample } from './types';

const execFileAsync = promisify(execFile);

const PYTHON_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 15_000;

type FetchMode = 'python' | 'remote' | 'disabled';

interface GoldPricePayload {
  ok?: boolean;
  xauPrice?: unknown;
  xauClose?: unknown;
  date?: unknown;
  tsj?: unknown;
  status?: unknown;
  error?: unknown;
}

function resolveMode(): FetchMode {
  const explicit = process.env.GOLDPRICE_FETCH_MODE?.trim().toLowerCase();
  if (explicit === 'python' || explicit === 'remote' || explicit === 'disabled') {
    return explicit;
  }
  // Unset (or unrecognised) is inferred: remote on Vercel, otherwise disabled.
  return process.env.VERCEL ? 'remote' : 'disabled';
}

function remoteUrl(): string | null {
  const explicit = process.env.GOLDPRICE_REMOTE_URL;
  if (explicit) {
    return /\/api\/goldprice\/?$/.test(explicit)
      ? explicit
      : `${explicit.replace(/\/$/, '')}/api/goldprice`;
  }
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  return host ? `https://${host}/api/goldprice` : null;
}

function parsePayload(payload: GoldPricePayload): Sample {
  if (payload.ok !== true) {
    const status = typeof payload.status === 'number' ? payload.status : undefined;
    const message =
      typeof payload.error === 'string' ? payload.error : 'not ok';
    return failure(
      'B_goldprice',
      `fetcher: ${status !== undefined ? `HTTP ${status} ` : ''}${message}`,
    );
  }

  const pkrPerOz = Number(payload.xauPrice);
  if (!Number.isFinite(pkrPerOz) || pkrPerOz <= 0) {
    return failure('B_goldprice', 'bad payload: xauPrice missing');
  }

  let providerAt: Date | null = null;
  if (typeof payload.date === 'string') {
    const parsed = Date.parse(payload.date);
    if (Number.isFinite(parsed)) providerAt = new Date(parsed);
  }
  if (providerAt === null && typeof payload.tsj === 'number') {
    if (Number.isFinite(payload.tsj)) providerAt = new Date(payload.tsj);
  }

  const close = Number(payload.xauClose);
  const note = Number.isFinite(close) && close > 0
    ? `previous close PKR ${close.toFixed(2)}/oz`
    : undefined;

  try {
    return {
      source: 'B_goldprice',
      ok: true,
      paisaPerGram: ingestPkrPerTroyOz(pkrPerOz),
      providerAt,
      ...(note ? { note } : {}),
    };
  } catch {
    return failure('B_goldprice', 'bad payload: price out of range');
  }
}

function parseJsonLine(text: string): GoldPricePayload | null {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) return null;
  try {
    return JSON.parse(line) as GoldPricePayload;
  } catch {
    return null;
  }
}

async function fetchViaPython(): Promise<Sample> {
  const python = process.env.PYTHON_BIN?.trim() || 'python';
  const script = path.join(process.cwd(), 'scripts', 'fetch_goldprice.py');

  try {
    const { stdout } = await execFileAsync(python, [script], {
      timeout: PYTHON_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const payload = parseJsonLine(String(stdout));
    if (!payload) {
      return failure('B_goldprice', 'python fetcher returned no JSON');
    }
    return parsePayload(payload);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return failure('B_goldprice', `python fetcher: ${text.slice(0, 200)}`);
  }
}

interface HttpsResult {
  status: number;
  contentType: string;
  body: string;
}

function httpsGet(url: string): Promise<HttpsResult> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          accept: 'application/json',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.setTimeout(REMOTE_TIMEOUT_MS, () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', reject);
  });
}

async function fetchViaRemote(): Promise<Sample> {
  const url = remoteUrl();
  if (!url) {
    return failure(
      'B_goldprice',
      'remote mode needs GOLDPRICE_REMOTE_URL or a Vercel URL variable',
    );
  }

  try {
    const result = await httpsGet(url);
    const head = result.body.slice(0, 200).replace(/\s+/g, ' ');

    if (result.status < 200 || result.status >= 300) {
      return failure(
        'B_goldprice',
        `remote HTTP ${result.status} ${result.contentType || '(no content-type)'}: ${head}`,
      );
    }
    if (!result.contentType.includes('json')) {
      return failure(
        'B_goldprice',
        `remote returned ${result.contentType || '(no content-type)'}: ${head}`,
      );
    }

    let payload: GoldPricePayload;
    try {
      payload = JSON.parse(result.body) as GoldPricePayload;
    } catch {
      return failure(
        'B_goldprice',
        `remote returned unparseable JSON: ${head}`,
      );
    }
    return parsePayload(payload);
  } catch (error) {
    return failure('B_goldprice', `remote: ${describeFetchError(error)}`);
  }
}

/**
 * GoldPrice.org, the brief's named fallback. Its WAF gates on TLS/JA3 and
 * browser navigation headers, so Node fetch is 403'd: locally we spawn
 * curl_cffi, on Vercel we call the Python function. One attempt per cycle (it
 * is per-IP rate limited).
 */
export async function fetchGoldPriceOrg(): Promise<Sample> {
  const mode = resolveMode();
  if (mode === 'disabled') {
    return failure('B_goldprice', 'disabled (no fetch mode)');
  }
  return mode === 'python' ? fetchViaPython() : fetchViaRemote();
}
