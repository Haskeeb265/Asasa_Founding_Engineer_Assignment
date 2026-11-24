'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_NOTIONAL_PAISA,
  MICRO,
  MIN_GOLD_UG,
  MIN_PKR_PAISA,
  TOLA_MICROGRAMS,
  formatGrams,
  formatPkr,
  formatTola,
  paisaPerTola,
  parseGrams,
  parsePkr,
  parseTola,
} from '../domain/units';
import { ceilDiv } from '../domain/trade-math';

type Side = 'buy' | 'sell';
type GoldUnit = 'gram' | 'tola';
type ToastTone = 'success' | 'error' | 'info';

interface Balances {
  pkr_paisa: string;
  user_gold_micrograms: string;
  platform_gold_micrograms: string;
  total_gold_micrograms: string;
}

interface Gate {
  ok: boolean;
  code: string | null;
  message: string;
  hint: string | null;
}

interface Sample {
  source: string;
  price_paisa_per_gram: string | null;
  accepted: boolean;
  selected: boolean;
  reason: string;
  provider_at: string | null;
  note?: string;
}

interface PricePanel {
  source: string;
  source_label: string;
  market_paisa_per_gram: string;
  buy_paisa_per_gram: string;
  sell_paisa_per_gram: string;
  guardrail_applied: boolean;
  fetched_at: string;
  fetch_age_seconds: number;
  provider_at: string | null;
  market_age_seconds: number | null;
  status: string;
  degraded: boolean;
  degraded_reason: string | null;
  kind: string;
  samples: Sample[];
}

interface PricePoint {
  fetched_at: string;
  price_paisa_per_gram: string | null;
  source: string;
}

interface Quote {
  id: string;
  side: Side;
  status: 'active' | 'confirmed' | 'settled' | 'expired' | 'cancelled' | 'rejected';
  input_mode: 'pkr' | 'grams';
  input_minor: string;
  market_paisa_per_gram: string;
  unit_paisa_per_gram: string;
  spread_bps: number;
  gold_micrograms: string;
  pkr_paisa: string;
  guardrail_paisa_per_gram: string;
  guardrail_applied: boolean;
  price_source: string;
  expires_at: string;
  created_at: string;
  seconds_remaining: number;
}

interface Trade {
  id: string;
  side: Side;
  gold_micrograms: string;
  pkr_paisa: string;
  unit_paisa_per_gram: string;
  price_source: string;
  source_label: string;
  settled_at: string;
  balances_before: Balances;
  balances_after: Balances;
}

interface Settings {
  guardrail_paisa_per_gram: string;
  quote_ttl_seconds: number;
  source_a_on: boolean;
  source_b_on: boolean;
  source_c_on: boolean;
  force_paused: boolean;
  divergence_threshold_bps: number;
  max_price_age_seconds: number;
  price_fetch_interval_seconds: number;
  price_override_paisa: string | null;
}

interface AppState {
  now: string;
  balances: Balances;
  gate: Gate;
  price: PricePanel | null;
  price_notice: { code: string; message: string; hint: string | null } | null;
  price_history: PricePoint[];
  quote: Quote | null;
  trades: Trade[];
  settings: Settings;
}

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    hint?: string;
    detail?: Record<string, unknown>;
  };
}

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}

class ApiError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, { cache: 'no-store', ...init, headers });
  const data = (await response.json().catch(() => null)) as (T & ErrorBody) | null;
  if (!response.ok) {
    const error = data?.error;
    const message = [error?.message, error?.hint].filter(Boolean).join(' — ');
    throw new ApiError(
      message || `Request failed (HTTP ${response.status}).`,
      error?.code ?? null,
    );
  }
  return data as T;
}

function plainMinor(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0');
  return `${whole}.${fraction}`;
}

function ratePerGram(paisa: string): string {
  return `${formatPkr(BigInt(paisa))}/g`;
}

function ratePerTola(paisa: string): string {
  return `${formatPkr(paisaPerTola(BigInt(paisa)))}/tola`;
}

function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return date.toLocaleString('en-PK', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-PK', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorTitle(error: unknown): string {
  if (!(error instanceof ApiError) || !error.code) return 'Request failed';
  const titles: Record<string, string> = {
    BELOW_MIN: 'Below the minimum',
    ABOVE_MAX: 'Above the maximum',
    INVALID_AMOUNT: 'Invalid amount',
    TOO_MANY_DECIMALS: 'Too many decimals',
    AMOUNT_NOT_POSITIVE: 'Amount not positive',
    INSUFFICIENT_PKR: 'Not enough PKR',
    INSUFFICIENT_GOLD: 'Not enough gold',
    INSUFFICIENT_INVENTORY: 'Not enough inventory',
    QUOTE_NOT_READY: 'Quote still counting down',
    QUOTE_EXPIRED: 'Quote expired',
    QUOTE_CANCELLED: 'Quote cancelled',
    QUOTE_SETTLED: 'Quote already settled',
    QUOTE_REJECTED: 'Quote rejected',
    TRADING_PAUSED: 'Trading paused',
    PRICE_UNAVAILABLE: 'Price unavailable',
    BAD_REQUEST: 'Request rejected',
  };
  return titles[error.code] ?? 'Request failed';
}

function tryParse<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function PriceChart({ history }: { history: PricePoint[] }) {
  const points = useMemo(
    () =>
      history
        .filter((point) => point.price_paisa_per_gram !== null)
        .map((point) => ({
          ...point,
          value: Number(BigInt(point.price_paisa_per_gram as string)),
        })),
    [history],
  );

  if (points.length === 0) {
    return <p className="chart-empty">No published price has been recorded yet.</p>;
  }

  const width = 760;
  const height = 210;
  const padX = 4;
  const padY = 18;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(1, max * 0.0001);
  const xFor = (index: number) =>
    points.length === 1
      ? width / 2
      : padX + (index * (width - padX * 2)) / (points.length - 1);
  const yFor = (value: number) =>
    height - padY - ((value - min) / span) * (height - padY * 2);
  const coords = points.map((point, index) => ({
    x: xFor(index),
    y: yFor(point.value),
  }));
  const line = coords.map((point) => `${point.x},${point.y}`).join(' ');
  const area =
    coords.length > 1
      ? `M ${coords[0].x},${height - padY} L ${line.replace(/ /g, ' L ')} L ${
          coords[coords.length - 1].x
        },${height - padY} Z`
      : '';
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <div className="chart-wrap">
      <div className="chart-scale" aria-hidden="true">
        <span>Low {formatPkr(BigInt(Math.round(min)))}</span>
        <span>High {formatPkr(BigInt(Math.round(max)))}</span>
      </div>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Published gold price per gram over time"
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8CCB50" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#8CCB50" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={0}
            x2={width}
            y1={height - padY - fraction * (height - padY * 2)}
            y2={height - padY - fraction * (height - padY * 2)}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="1"
          />
        ))}
        {area ? <path d={area} fill="url(#chart-fill)" /> : null}
        {coords.length > 1 ? (
          <polyline
            points={line}
            fill="none"
            stroke="#8CCB50"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <circle
          cx={coords[coords.length - 1].x}
          cy={coords[coords.length - 1].y}
          r="5"
          fill="#8CCB50"
          stroke="#0D4A46"
          strokeWidth="3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="chart-times">
        <span>{formatTime(first.fetched_at)}</span>
        <span>
          {points.length} published point{points.length === 1 ? '' : 's'}
        </span>
        <span>{formatTime(last.fetched_at)}</span>
      </div>
    </div>
  );
}

export default function Page() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [side, setSide] = useState<Side>('buy');
  const [buyInput, setBuyInput] = useState('5000.00');
  const [sellUnit, setSellUnit] = useState<GoldUnit>('gram');
  const [sellInput, setSellInput] = useState('1.000000');
  const [guardrail, setGuardrail] = useState('0.00');
  const [guardrailDirty, setGuardrailDirty] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [clock, setClock] = useState(() => Date.now());
  const [serverOffset, setServerOffset] = useState(0);
  const toastId = useRef(0);
  const pollFailed = useRef(false);
  const readyNotified = useRef<string | null>(null);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((tone: ToastTone, title: string, message?: string) => {
    const id = ++toastId.current;
    setToasts((current) => [...current.slice(-3), { id, tone, title, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 6500);
  }, []);

  const refresh = useCallback(
    async (silent = false) => {
      try {
        const next = await api<AppState>('/api/state');
        setState(next);
        setError(null);
        pollFailed.current = false;
        return next;
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        if (!silent || !pollFailed.current) {
          pushToast('error', 'Connection problem', message);
          pollFailed.current = true;
        }
        return null;
      }
    },
    [pushToast],
  );

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const next = await api<AppState>('/api/state');
        if (stopped) return;
        setState(next);
        setError(null);
        pollFailed.current = false;
      } catch (caught) {
        if (stopped) return;
        const message = errorMessage(caught);
        setError(message);
        if (!pollFailed.current) {
          pushToast('error', 'Connection problem', message);
          pollFailed.current = true;
        }
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pushToast]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (state?.now) setServerOffset(Date.parse(state.now) - Date.now());
  }, [state?.now]);

  useEffect(() => {
    if (!guardrailDirty && state) {
      setGuardrail(plainMinor(BigInt(state.settings.guardrail_paisa_per_gram), 2));
    }
  }, [state, guardrailDirty]);

  const quote = state?.quote ?? null;
  const quoteSeconds = quote
    ? Math.max(0, Math.ceil((Date.parse(quote.expires_at) - (clock + serverOffset)) / 1000))
    : 0;
  const quoteReady = quote?.status === 'active' && quoteSeconds === 0;
  const quoteTtl = Math.max(1, state?.settings.quote_ttl_seconds ?? 75);
  const quoteProgress = quote
    ? Math.min(100, Math.max(0, ((quoteTtl - quoteSeconds) / quoteTtl) * 100))
    : 0;

  useEffect(() => {
    if (!quote) {
      readyNotified.current = null;
      return;
    }
    if (quote.status === 'active' && quoteSeconds === 0 && readyNotified.current !== quote.id) {
      readyNotified.current = quote.id;
      pushToast(
        'info',
        'Quote ready to confirm',
        'The countdown has finished. Confirm to execute, or cancel the quote.',
      );
    }
  }, [quote, quoteSeconds, pushToast]);

  const buyPkr = tryParse(() => parsePkr(buyInput));
  const sellGold = tryParse(() =>
    sellUnit === 'gram' ? parseGrams(sellInput) : parseTola(sellInput),
  );
  const buyPrice = state?.price ? BigInt(state.price.buy_paisa_per_gram) : null;
  const sellPrice = state?.price ? BigInt(state.price.sell_paisa_per_gram) : null;
  const buyGold = buyPkr !== null && buyPrice !== null ? (buyPkr * MICRO) / buyPrice : null;
  const buyCharged =
    buyGold !== null && buyPrice !== null ? ceilDiv(buyGold * buyPrice, MICRO) : null;
  const sellPkr =
    sellGold !== null && sellPrice !== null ? (sellGold * sellPrice) / MICRO : null;

  const userGold = state ? BigInt(state.balances.user_gold_micrograms) : 0n;
  const walletPkr = state ? BigInt(state.balances.pkr_paisa) : 0n;
  const inventoryGold = state ? BigInt(state.balances.platform_gold_micrograms) : 0n;

  let formError: string | null = null;
  if (side === 'buy') {
    if (buyInput.trim() === '') {
      formError = 'Enter a PKR amount.';
    } else if (buyPkr === null) {
      formError = 'Enter a valid PKR amount with at most 2 decimals.';
    } else if (buyPkr < MIN_PKR_PAISA) {
      formError = `Minimum buy is ${formatPkr(MIN_PKR_PAISA)}.`;
    } else if (buyPkr > MAX_NOTIONAL_PAISA) {
      formError = `Maximum buy is ${formatPkr(MAX_NOTIONAL_PAISA)}.`;
    } else if (buyPkr > walletPkr) {
      formError = `Your PKR balance is ${formatPkr(walletPkr)}.`;
    } else if (buyGold !== null && buyGold > inventoryGold) {
      formError = `Platform inventory only covers ${formatGrams(inventoryGold)}.`;
    }
  } else if (sellInput.trim() === '') {
    formError = 'Enter a gold amount.';
  } else if (sellGold === null) {
    formError = 'Enter a valid gold amount with at most 6 decimals.';
  } else if (sellGold < MIN_GOLD_UG) {
    formError = `Minimum sell is ${formatGrams(MIN_GOLD_UG)}.`;
  } else if (sellGold > userGold) {
    formError = `Your gold balance is ${formatGrams(userGold)}.`;
  } else if (sellPkr !== null && sellPkr > MAX_NOTIONAL_PAISA) {
    formError = `Maximum sell notional is ${formatPkr(MAX_NOTIONAL_PAISA)}.`;
  }

  const historyValues = (state?.price_history ?? [])
    .map((point) => (point.price_paisa_per_gram ? BigInt(point.price_paisa_per_gram) : null))
    .filter((value): value is bigint => value !== null);
  const firstHistory = historyValues[0] ?? null;
  const lastHistory = historyValues[historyValues.length - 1] ?? null;
  const priceChangePct =
    firstHistory !== null && lastHistory !== null && historyValues.length > 1
      ? Number(((lastHistory - firstHistory) * 10_000n) / firstHistory) / 100
      : null;

  const currentMarket =
    state?.price?.market_paisa_per_gram ?? state?.price_history.at(-1)?.price_paisa_per_gram ?? null;
  const goldValue = currentMarket && state ? (userGold * BigInt(currentMarket)) / MICRO : null;
  const chartAge =
    state?.price?.fetch_age_seconds ??
    (state?.price_history.at(-1)
      ? Math.max(
          0,
          Math.floor(
            (Date.parse(state.now) - Date.parse(state.price_history.at(-1)!.fetched_at)) / 1000,
          ),
        )
      : null);

  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy('action');
    setError(null);
    try {
      await action();
      return true;
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      pushToast('error', errorTitle(caught), message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  function chooseSide(next: Side) {
    if (quote) {
      pushToast(
        'info',
        'Finish the live quote first',
        'Confirm or cancel the current quote before switching between buy and sell.',
      );
      return;
    }
    setSide(next);
  }

  function changeSellUnit(next: GoldUnit) {
    if (next === sellUnit) return;
    if (sellGold !== null) {
      if (next === 'tola') {
        const tolaScaled = (sellGold * MICRO) / TOLA_MICROGRAMS;
        setSellInput(plainMinor(tolaScaled, 6));
      } else {
        setSellInput(plainMinor(sellGold, 6));
      }
    }
    setSellUnit(next);
  }

  function createQuote() {
    if (quote) {
      pushToast(
        'info',
        'A quote is already live',
        'Confirm or cancel it before creating another one.',
      );
      return;
    }
    if (!state?.gate.ok) {
      pushToast('error', 'Trading is paused', state?.gate.message ?? 'No usable price.');
      return;
    }
    if (formError) {
      pushToast('error', 'Check the amount', formError);
      return;
    }

    void run(async () => {
      const body =
        side === 'buy'
          ? { side, input_mode: 'pkr', input: buyInput.trim() }
          : (() => {
              if (sellGold === null) throw new Error('Enter a gold amount.');
              return {
                side,
                input_mode: 'grams',
                input: plainMinor(sellGold, 6),
              };
            })();
      const result = await api<{ quote: Quote }>('/api/quotes', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      pushToast(
        'success',
        'Quote locked',
        `Rate ${ratePerGram(result.quote.unit_paisa_per_gram)}. Confirm unlocks after ${result.quote.seconds_remaining}s.`,
      );
      await refresh(true);
    });
  }

  function confirmQuote(current: Quote) {
    void run(async () => {
      const result = await api<{
        quote: Quote;
        trade_id: string | null;
        replayed: boolean;
      }>(`/api/quotes/${current.id}/confirm`, { method: 'POST' });
      if (result.trade_id) {
        pushToast(
          'success',
          'Trade settled',
          `Receipt ${result.trade_id.slice(0, 8)} is in your history.`,
        );
      } else {
        pushToast('info', 'Quote confirmed', 'The server is settling the trade.');
      }
      await refresh(true);
    });
  }

  function cancelQuote(current: Quote) {
    void run(async () => {
      await api(`/api/quotes/${current.id}/cancel`, { method: 'POST' });
      pushToast('success', 'Quote cancelled', 'No money moved. You can create a new quote.');
      await refresh(true);
    });
  }

  async function demo(
    label: string,
    path: string,
    body: unknown,
    title: string,
    message: string,
  ): Promise<boolean> {
    return run(async () => {
      await api(`/api/demo/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      pushToast('success', title, message);
      await refresh(true);
    });
  }

  async function applyGuardrail() {
    const ok = await demo(
      'guardrail',
      'guardrail',
      { value: guardrail },
      'Guardrail updated',
      `Buy price floor is ${guardrail.trim()}/g. A value of 0 disables it.`,
    );
    if (ok) setGuardrailDirty(false);
  }

  const visibleRate =
    side === 'buy' ? buyPrice : sellPrice;
  const selectedUnitRate =
    visibleRate !== null && side === 'sell' && sellUnit === 'tola'
      ? paisaPerTola(visibleRate)
      : visibleRate;

  const tradingOpen = state?.gate.ok ?? false;
  const statusLabel = state ? (tradingOpen ? 'Trading open' : 'Trading paused') : 'Connecting';
  const statusTone = state ? (tradingOpen ? 'is-open' : 'is-closed') : 'is-loading';
  const changeTone =
    priceChangePct === null ? 'flat' : priceChangePct >= 0 ? 'up' : 'down';
  const changeText =
    priceChangePct === null
      ? '—'
      : `${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%`;

  return (
    <div className="app-shell">
      <style>{`
        :root {
          --forest: #0D4A46;
          --forest-deep: #083733;
          --forest-soft: #E7F0EC;
          --lime: #8CCB50;
          --lime-deep: #6EAD37;
          --lime-soft: #EEF8E4;
          --paper: #F9FAFA;
          --ink: #1A1F1B;
          --surface: #FFFFFF;
          --muted: #63716B;
          --line: #E1E8E3;
          --line-strong: #C9D5CE;
          --danger: #A62B24;
          --danger-soft: #FBECEB;
          --warning: #7A5600;
          --warning-soft: #FFF5DD;
          --shadow: 0 14px 40px rgba(13, 74, 70, 0.07);
        }

        * { box-sizing: border-box; }
        html { background: var(--paper); }
        body { margin: 0; background: var(--paper); color: var(--ink); }
        button, input { font: inherit; }
        button { -webkit-tap-highlight-color: transparent; }
        button:disabled { cursor: not-allowed; opacity: 0.48; }
        :where(button, input, summary, a):focus-visible {
          outline: 3px solid rgba(140, 203, 80, 0.72);
          outline-offset: 2px;
        }
        .sr-only {
          position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
          overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
        }

        .app-shell {
          min-height: 100vh;
          background:
            radial-gradient(760px 420px at 92% -8%, rgba(140, 203, 80, 0.18), transparent 68%),
            var(--paper);
          padding-bottom: max(28px, env(safe-area-inset-bottom));
        }
        .wrap {
          width: min(calc(100% - 28px), 1180px);
          margin: 0 auto;
        }

        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 15px 0 13px;
        }
        .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .brand-mark {
          display: grid; place-items: center; width: 38px; height: 38px;
          flex: 0 0 auto; border-radius: 12px; background: var(--forest);
          color: var(--lime); box-shadow: 0 6px 18px rgba(13, 74, 70, 0.18);
        }
        .brand-copy { min-width: 0; }
        .brand-copy strong {
          display: block; font-size: 16px; line-height: 1.1;
          letter-spacing: -0.025em;
        }
        .brand-copy span {
          display: block; margin-top: 3px; color: var(--muted);
          font-size: 10px; line-height: 1.2; letter-spacing: 0.08em;
          text-transform: uppercase; white-space: nowrap;
        }
        .topbar-meta { display: flex; align-items: center; gap: 8px; }
        .status-chip {
          display: inline-flex; align-items: center; gap: 6px;
          min-height: 34px; padding: 0 10px; border: 1px solid var(--line);
          border-radius: 999px; background: rgba(255,255,255,0.78);
          color: var(--muted); font-size: 11px; font-weight: 700; white-space: nowrap;
        }
        .status-chip i {
          width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong);
        }
        .status-chip.is-open { color: var(--forest); border-color: #CBE1CE; background: #F3FAF2; }
        .status-chip.is-open i { background: var(--lime-deep); box-shadow: 0 0 0 3px rgba(140,203,80,.2); }
        .status-chip.is-closed { color: var(--danger); border-color: #EDC9C6; background: var(--danger-soft); }
        .status-chip.is-closed i { background: var(--danger); }
        .market-id {
          display: none; min-height: 34px; align-items: center; padding: 0 10px;
          border-radius: 999px; background: var(--forest-soft); color: var(--forest);
          font-size: 10px; font-weight: 800; letter-spacing: 0.08em;
        }

        .alert {
          display: flex; gap: 10px; align-items: flex-start;
          margin-bottom: 12px; padding: 12px 14px; border: 1px solid #EDC9C6;
          border-radius: 12px; background: var(--danger-soft); color: var(--danger);
          font-size: 13px; line-height: 1.45;
        }
        .alert strong { display: block; font-size: 13px; }

        .market-card {
          position: relative; overflow: hidden; margin-bottom: 14px;
          padding: 18px 16px 14px; border-radius: 20px;
          background: var(--forest); color: #FFFFFF;
          box-shadow: 0 18px 40px rgba(13, 74, 70, 0.18);
        }
        .market-card::after {
          content: ""; position: absolute; width: 260px; height: 260px;
          right: -130px; top: -150px; border-radius: 50%;
          background: radial-gradient(circle, rgba(140,203,80,0.3), transparent 68%);
          pointer-events: none;
        }
        .market-top { position: relative; z-index: 1; display: grid; gap: 15px; }
        .market-eyebrow {
          display: flex; align-items: center; gap: 8px;
          color: rgba(255,255,255,0.68); font-size: 10px; font-weight: 800;
          letter-spacing: 0.11em; text-transform: uppercase;
        }
        .market-live {
          display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px;
          border-radius: 999px; background: rgba(140,203,80,0.16);
          color: var(--lime); font-size: 9px; letter-spacing: 0.08em;
        }
        .market-live i { width: 4px; height: 4px; border-radius: 50%; background: var(--lime); }
        .market-price {
          margin: 7px 0 0; font-size: clamp(34px, 10.5vw, 52px);
          line-height: 0.96; font-weight: 750; letter-spacing: -0.055em;
          font-variant-numeric: tabular-nums;
        }
        .market-price small { font-size: 0.35em; letter-spacing: -0.02em; font-weight: 650; opacity: 0.62; }
        .market-change {
          display: flex; align-items: center; flex-wrap: wrap; gap: 7px;
          margin-top: 8px; color: rgba(255,255,255,0.58); font-size: 11px;
        }
        .change-pill {
          display: inline-flex; align-items: center; min-height: 23px; padding: 0 7px;
          border-radius: 6px; font-size: 11px; font-weight: 800;
          font-variant-numeric: tabular-nums;
        }
        .change-pill.up { background: rgba(140,203,80,0.16); color: var(--lime); }
        .change-pill.down { background: rgba(255,145,131,0.13); color: #FFB0A3; }
        .change-pill.flat { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.66); }
        .market-side {
          display: flex; justify-content: space-between; align-items: end; gap: 12px;
          padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.12);
        }
        .market-side-label {
          display: block; color: rgba(255,255,255,0.55); font-size: 9px;
          font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
        }
        .market-side strong {
          display: block; margin-top: 4px; font-size: 15px; letter-spacing: -0.02em;
          font-variant-numeric: tabular-nums;
        }
        .market-freshness {
          display: flex; align-items: center; justify-content: flex-end; gap: 6px;
          max-width: 52%; color: rgba(255,255,255,0.56); font-size: 10px;
          line-height: 1.35; text-align: right;
        }
        .market-freshness i {
          width: 5px; height: 5px; border-radius: 50%; background: var(--lime); flex: 0 0 auto;
        }

        .chart-wrap { position: relative; z-index: 1; margin-top: 13px; }
        .chart-scale {
          display: flex; justify-content: space-between; margin-bottom: 2px;
          color: rgba(255,255,255,0.46); font-size: 9px; font-weight: 600;
          font-variant-numeric: tabular-nums;
        }
        .chart-svg { display: block; width: 100%; height: 118px; overflow: visible; }
        .chart-times {
          display: flex; justify-content: space-between; gap: 8px; margin-top: 3px;
          color: rgba(255,255,255,0.42); font-size: 9px; font-variant-numeric: tabular-nums;
        }
        .chart-times span:nth-child(2) { color: rgba(255,255,255,0.32); }
        .chart-empty {
          margin: 16px 0 6px; padding: 22px 14px; border: 1px dashed rgba(255,255,255,0.2);
          border-radius: 12px; color: rgba(255,255,255,0.6); font-size: 12px; text-align: center;
        }

        .market-footer {
          position: relative; z-index: 1; display: flex; flex-wrap: wrap; align-items: center;
          gap: 7px; margin-top: 12px; padding-top: 11px;
          border-top: 1px solid rgba(255,255,255,0.12);
        }
        .rate-pill {
          display: inline-flex; align-items: center; gap: 6px; min-height: 28px;
          padding: 0 9px; border-radius: 7px; background: rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.62); font-size: 10px;
        }
        .rate-pill strong {
          color: #FFFFFF; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
        }
        .market-source {
          margin-left: auto; color: rgba(255,255,255,0.42);
          font-size: 9px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
        }

        .balances {
          display: grid; grid-template-columns: 1fr; gap: 9px; margin-bottom: 14px;
        }
        .balance {
          min-width: 0; padding: 13px 15px; border: 1px solid #7DBA46;
          border-radius: 14px; background: var(--lime); color: #FFFFFF;
          box-shadow: 0 5px 16px rgba(110, 173, 55, 0.16);
        }
        .balance-label {
          display: flex; align-items: center; gap: 6px; color: #FFFFFF;
          font-size: 9px; font-weight: 800; letter-spacing: 0.08em;
          text-transform: uppercase; text-shadow: 0 1px 1px rgba(13, 74, 70, 0.18);
        }
        .balance strong {
          display: block; margin-top: 5px; color: #FFFFFF; font-size: 20px;
          letter-spacing: -0.04em; font-variant-numeric: tabular-nums;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          text-shadow: 0 1px 1px rgba(13, 74, 70, 0.18);
        }
        .balance small {
          display: block; margin-top: 3px; color: rgba(255, 255, 255, 0.78);
          font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis;
        }

        .trade-layout { display: grid; gap: 14px; }
        .panel {
          border: 1px solid var(--line); border-radius: 18px; background: var(--surface);
          box-shadow: var(--shadow);
        }
        .trade-panel { padding: 17px 15px 15px; }
        .panel-head {
          display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
          margin-bottom: 13px;
        }
        .eyebrow {
          display: block; margin-bottom: 2px; color: var(--muted); font-size: 9px;
          font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
        }
        .panel h2 {
          margin: 0; font-size: 20px; line-height: 1.15; letter-spacing: -0.035em;
        }
        .head-note {
          display: inline-flex; align-items: center; min-height: 23px; padding: 0 7px;
          border-radius: 6px; background: var(--forest-soft); color: var(--forest);
          font-size: 9px; font-weight: 700; white-space: nowrap;
        }

        .side-tabs {
          display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 14px;
          padding: 4px; border-radius: 12px; background: #EEF3F0;
        }
        .side-tabs button {
          display: inline-flex; align-items: center; justify-content: center; gap: 7px;
          min-height: 45px; padding: 0 8px; border: 0; border-radius: 9px;
          background: transparent; color: var(--muted); font-size: 13px;
          font-weight: 750; cursor: pointer;
          transition: background 160ms ease, color 160ms ease, transform 160ms ease;
        }
        .side-tabs button:hover { color: var(--forest); }
        .side-tabs button:active { transform: scale(0.985); }
        .side-tabs button.active { background: var(--forest); color: #FFFFFF; box-shadow: 0 5px 14px rgba(13,74,70,0.16); }
        .side-tabs button.active[data-side="sell"] { background: var(--ink); }
        .side-tabs svg { opacity: 0.8; }

        .field-head {
          display: flex; align-items: center; justify-content: space-between; gap: 10px;
          margin-bottom: 7px;
        }
        .field-head > span { color: var(--ink); font-size: 11px; font-weight: 750; }
        .field-balance { color: var(--muted) !important; font-size: 9px !important; font-weight: 600 !important; }
        .amount-box {
          display: block; padding: 12px 13px; border: 1px solid var(--line-strong);
          border-radius: 13px; background: #FBFCFB;
          transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
        }
        .amount-box:focus-within {
          border-color: var(--forest); background: #FFFFFF;
          box-shadow: 0 0 0 4px rgba(13,74,70,0.09);
        }
        .amount-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .amount-prefix, .amount-suffix {
          flex: 0 0 auto; color: var(--forest); font-size: 14px; font-weight: 800;
        }
        .amount-input {
          width: 100%; min-width: 0; padding: 0; border: 0; outline: 0;
          background: transparent; color: var(--ink);
          font-size: clamp(25px, 8vw, 34px); font-weight: 750; line-height: 1.2;
          letter-spacing: -0.045em; font-variant-numeric: tabular-nums;
        }
        .amount-input::placeholder { color: #AAB7B0; }
        .field-foot {
          display: block; margin-top: 4px; color: var(--muted); font-size: 9px;
        }

        .unit-switch {
          display: flex; gap: 3px; padding: 3px; border-radius: 8px; background: #EEF3F0;
        }
        .unit-switch button {
          min-height: 36px; padding: 0 10px; border: 0; border-radius: 6px;
          background: transparent; color: var(--muted); font-size: 10px;
          font-weight: 750; cursor: pointer;
        }
        .unit-switch button.on { background: #FFFFFF; color: var(--forest); box-shadow: 0 1px 4px rgba(13,74,70,0.12); }

        .form-error {
          display: flex; gap: 6px; align-items: flex-start; margin: 9px 0 0;
          color: var(--danger); font-size: 10px; line-height: 1.4;
        }
        .form-error::before {
          content: "!"; display: grid; place-items: center; width: 14px; height: 14px;
          flex: 0 0 auto; border-radius: 50%; background: var(--danger-soft);
          font-size: 9px; font-weight: 900;
        }

        .order-preview {
          margin-top: 11px; overflow: hidden; border: 1px solid var(--line);
          border-radius: 13px; background: #FBFCFB;
        }
        .preview-highlight {
          padding: 11px 12px; background: var(--lime-soft);
          border-bottom: 1px solid #DFEECC;
        }
        .preview-label {
          display: block; color: var(--muted); font-size: 9px;
          font-weight: 800; letter-spacing: 0.07em; text-transform: uppercase;
        }
        .preview-highlight .preview-label { color: #547638; }
        .preview-value {
          display: block; margin-top: 2px; color: var(--forest); font-size: 23px;
          font-weight: 780; letter-spacing: -0.04em; font-variant-numeric: tabular-nums;
          overflow-wrap: anywhere;
        }
        .preview-sub {
          display: block; margin-top: 1px; color: #688052; font-size: 10px;
          font-variant-numeric: tabular-nums;
        }
        .preview-rows { padding: 4px 12px; }
        .preview-row {
          display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
          padding: 7px 0; border-bottom: 1px solid #EDF1EE; font-size: 11px;
        }
        .preview-row:last-child { border-bottom: 0; }
        .preview-row span:first-child { color: var(--muted); }
        .preview-row span:last-child, .preview-row strong {
          color: var(--ink); font-weight: 700; text-align: right;
          font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
        }

        .formula-note {
          margin-top: 10px; border-radius: 10px; background: #F7F9F7;
          color: var(--muted); font-size: 10px;
        }
        .formula-note summary {
          min-height: 40px; padding: 10px; cursor: pointer; font-weight: 700;
          list-style: none;
        }
        .formula-note summary::-webkit-details-marker { display: none; }
        .formula-note summary::after {
          content: "+"; float: right; color: var(--forest); font-size: 14px; line-height: 1;
        }
        .formula-note[open] summary::after { content: "−"; }
        .formula-body { padding: 0 10px 10px; line-height: 1.55; }
        .formula-body code {
          display: block; margin: 4px 0; padding: 5px 7px; border-radius: 5px;
          background: #FFFFFF; color: var(--forest); font-size: 9px;
          white-space: normal; overflow-wrap: anywhere;
        }

        .btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 7px;
          min-height: 44px; padding: 0 14px; border-radius: 10px;
          border: 1px solid transparent; font-size: 12px; font-weight: 800;
          cursor: pointer; transition: transform 160ms ease, box-shadow 160ms ease,
            background 160ms ease, border-color 160ms ease;
        }
        .btn:hover:not(:disabled) { transform: translateY(-1px); }
        .btn:active:not(:disabled) { transform: translateY(0) scale(0.995); }
        .btn-primary {
          width: 100%; min-height: 50px; margin-top: 12px;
          background: var(--lime); border-color: #7DBA46; color: var(--ink);
          box-shadow: 0 7px 16px rgba(140,203,80,0.1);
        }
        .btn-primary:hover:not(:disabled) { background: #98D45D; box-shadow: 0 9px 20px rgba(140,203,80,0.18); }
        .btn-forest { background: var(--forest); border-color: var(--forest); color: #FFFFFF; }
        .btn-forest:hover:not(:disabled) { background: var(--forest-deep); }
        .btn-secondary {
          background: #FFFFFF; border-color: var(--line-strong); color: var(--forest);
        }
        .btn-secondary:hover:not(:disabled) { border-color: var(--forest); background: var(--forest-soft); }
        .btn-danger {
          background: #FFFFFF; border-color: #E8C6C2; color: var(--danger);
        }
        .btn-danger:hover:not(:disabled) { background: var(--danger-soft); }
        .btn-full { width: 100%; }
        .action-hint {
          margin: 8px 0 0; color: var(--muted); font-size: 9px; line-height: 1.45; text-align: center;
        }

        .quote-panel { padding: 17px 15px 15px; }
        .status-pill {
          display: inline-flex; align-items: center; gap: 5px; min-height: 23px;
          padding: 0 7px; border-radius: 6px; font-size: 9px; font-weight: 800;
          white-space: nowrap;
        }
        .status-pill.live { background: var(--warning-soft); color: var(--warning); }
        .status-pill.ready { background: var(--lime-soft); color: #4E702F; }
        .quote-empty { padding: 3px 0 2px; }
        .quote-empty p {
          margin: 0 0 12px; color: var(--muted); font-size: 11px; line-height: 1.5;
        }
        .quote-steps { display: grid; gap: 8px; }
        .quote-step {
          display: flex; align-items: center; gap: 9px; padding: 9px 10px;
          border: 1px solid #EDF1EE; border-radius: 9px; background: #FBFCFB;
          color: var(--muted); font-size: 10px; line-height: 1.35;
        }
        .quote-step b {
          display: grid; place-items: center; width: 20px; height: 20px;
          flex: 0 0 auto; border-radius: 50%; background: var(--forest-soft);
          color: var(--forest); font-size: 9px;
        }

        .quote-meta-line {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
          margin-bottom: 10px;
        }
        .quote-side {
          display: inline-flex; align-items: center; min-height: 25px; padding: 0 8px;
          border-radius: 6px; background: var(--forest); color: #FFFFFF;
          font-size: 9px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
        }
        .quote-side.sell { background: var(--ink); }
        .quote-time {
          display: flex; align-items: baseline; gap: 6px; margin-bottom: 7px;
        }
        .quote-seconds {
          color: var(--forest); font-size: 48px; line-height: 0.9; font-weight: 780;
          letter-spacing: -0.07em; font-variant-numeric: tabular-nums;
        }
        .quote-time small { color: var(--muted); font-size: 10px; }
        .quote-timer-copy {
          margin-left: auto; max-width: 150px; color: var(--muted);
          font-size: 9px; line-height: 1.4; text-align: right;
        }
        .quote-timer-copy strong { display: block; color: var(--forest); font-size: 10px; }
        .quote-progress {
          height: 5px; margin-bottom: 12px; overflow: hidden;
          border-radius: 999px; background: #EAF0EC;
        }
        .quote-progress span {
          display: block; height: 100%; border-radius: inherit; background: var(--forest);
          transition: width 250ms linear, background 200ms ease;
        }
        .quote-progress.ready span { background: var(--lime); }

        .quote-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
          overflow: hidden; margin-bottom: 10px; border: 1px solid var(--line);
          border-radius: 11px; background: var(--line);
        }
        .quote-cell { min-width: 0; padding: 9px 10px; background: #FBFCFB; }
        .quote-cell span {
          display: block; color: var(--muted); font-size: 8px; font-weight: 800;
          letter-spacing: 0.07em; text-transform: uppercase;
        }
        .quote-cell strong {
          display: block; margin-top: 3px; color: var(--ink); font-size: 12px;
          line-height: 1.3; font-weight: 750; font-variant-numeric: tabular-nums;
          overflow-wrap: anywhere;
        }
        .quote-cell small { display: block; margin-top: 2px; color: var(--muted); font-size: 9px; }
        .guardrail-note {
          margin: 0 0 10px; padding: 7px 9px; border-radius: 7px;
          background: var(--warning-soft); color: var(--warning); font-size: 9px; line-height: 1.4;
        }
        .quote-copy { margin: 0 0 11px; color: var(--muted); font-size: 10px; line-height: 1.5; }
        .quote-actions { display: grid; grid-template-columns: 1.3fr 1fr; gap: 8px; }

        .history-panel { margin-top: 14px; padding: 17px 15px 15px; }
        .section-head {
          display: flex; align-items: flex-end; justify-content: space-between; gap: 12px;
          margin-bottom: 13px;
        }
        .section-head h2 { margin: 0; font-size: 21px; letter-spacing: -0.035em; }
        .count-pill {
          display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px;
          border-radius: 999px; background: #F0F4F1; color: var(--muted);
          font-size: 9px; font-weight: 700; white-space: nowrap;
        }
        .history-empty {
          padding: 30px 16px; border: 1px dashed var(--line-strong); border-radius: 13px;
          color: var(--muted); font-size: 11px; line-height: 1.5; text-align: center;
        }
        .history-table-wrap { border-radius: 14px; }
        .history-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .history-table thead { display: none; }
        .history-table tbody { display: grid; gap: 10px; }
        .history-table tr {
          display: grid; grid-template-columns: 1fr 1fr; overflow: hidden;
          border: 1px solid var(--line); border-radius: 12px; background: #FFFFFF;
        }
        .history-table td {
          display: block; min-width: 0; padding: 11px 12px;
          border-bottom: 1px solid #EDF1EE; vertical-align: top;
        }
        .history-table td:last-child { border-bottom: 0; }
        .history-table td::before {
          content: attr(data-label); display: block; margin-bottom: 4px;
          color: var(--muted); font-size: 8px; font-weight: 800;
          letter-spacing: 0.07em; line-height: 1.25; text-transform: uppercase;
        }
        .history-table td > strong {
          display: block; color: var(--ink); font-size: 12px; font-weight: 750;
          line-height: 1.35; font-variant-numeric: tabular-nums;
          overflow-wrap: anywhere;
        }
        .history-table td > small {
          display: block; margin-top: 2px; color: var(--muted); font-size: 9px;
          line-height: 1.4; font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
        }
        .history-table td.history-trade {
          display: flex; align-items: center; flex-wrap: wrap; gap: 7px;
          grid-column: 1 / -1; padding: 10px 12px;
          background: #FBFCFB; border-bottom: 1px solid var(--line);
        }
        .history-table td.history-trade::before { display: none; }
        .history-side {
          display: inline-flex; align-items: center; min-height: 22px; padding: 0 7px;
          border-radius: 5px; font-size: 8px; font-weight: 850;
          letter-spacing: 0.07em; text-transform: uppercase;
        }
        .history-side.buy { background: var(--lime-soft); color: #4C702D; }
        .history-side.sell { background: var(--forest-soft); color: var(--forest); }
        .history-time {
          color: var(--muted); font-size: 9px; font-variant-numeric: tabular-nums;
        }
        .history-table .history-rate,
        .history-table .history-source,
        .history-table .history-receipt,
        .history-table .history-after { grid-column: 1 / -1; }
        .history-table .history-source strong { font-size: 11px; line-height: 1.45; }
        .history-table .history-receipt code {
          display: block; color: var(--forest); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 9px; line-height: 1.5; letter-spacing: 0.01em;
          white-space: normal; overflow-wrap: anywhere;
        }
        .history-after-list { display: grid; gap: 4px; }
        .history-after-line {
          display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
          color: var(--muted); font-size: 10px; line-height: 1.4;
        }
        .history-after-line strong {
          color: var(--ink); font-weight: 750; font-variant-numeric: tabular-nums;
          text-align: right; overflow-wrap: anywhere;
        }

        .demo-panel {
          margin-top: 14px; border: 1px solid var(--line); border-radius: 15px;
          background: rgba(255,255,255,0.72); overflow: hidden;
        }
        .demo-panel > summary {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          min-height: 56px; padding: 12px 15px; cursor: pointer; list-style: none;
        }
        .demo-panel > summary::-webkit-details-marker { display: none; }
        .demo-title { display: block; color: var(--ink); font-size: 12px; font-weight: 750; }
        .demo-hint { display: block; margin-top: 2px; color: var(--muted); font-size: 9px; }
        .demo-chevron {
          display: grid; place-items: center; width: 26px; height: 26px;
          flex: 0 0 auto; border-radius: 50%; background: var(--forest-soft);
          color: var(--forest); font-size: 15px; transition: transform 160ms ease;
        }
        .demo-panel[open] .demo-chevron { transform: rotate(45deg); }
        .demo-body { padding: 0 15px 15px; border-top: 1px solid var(--line); }
        .demo-grid { display: grid; gap: 10px; margin-top: 12px; }
        .demo-block { padding: 11px; border: 1px solid #EDF1EE; border-radius: 10px; background: #FBFCFB; }
        .demo-block h3 {
          margin: 0 0 8px; color: var(--ink); font-size: 9px; font-weight: 800;
          letter-spacing: 0.07em; text-transform: uppercase;
        }
        .demo-actions { display: flex; flex-wrap: wrap; gap: 6px; }
        .demo-actions .btn { min-height: 40px; padding: 0 10px; font-size: 9px; border-radius: 7px; }
        .demo-input {
          width: 100%; min-height: 38px; padding: 7px 9px; border: 1px solid var(--line-strong);
          border-radius: 7px; background: #FFFFFF; color: var(--ink);
          font-size: 12px; font-variant-numeric: tabular-nums;
        }
        .demo-block label { display: grid; gap: 5px; color: var(--muted); font-size: 9px; font-weight: 650; }
        .demo-note { margin: 6px 0 0; color: var(--muted); font-size: 8px; line-height: 1.45; }

        .page-foot {
          display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 14px;
          margin-top: 18px; color: #87948D; font-size: 8px; line-height: 1.45;
        }
        .page-foot .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

        .loading-panel {
          display: flex; align-items: center; justify-content: center; gap: 10px;
          min-height: 240px; border: 1px solid var(--line); border-radius: 18px;
          background: #FFFFFF; color: var(--muted); font-size: 12px;
        }
        .spinner {
          width: 16px; height: 16px; border: 2px solid var(--forest-soft);
          border-top-color: var(--forest); border-radius: 50%;
          animation: spin 800ms linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .toasts {
          position: fixed; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom));
          left: 12px; z-index: 100; display: grid; gap: 7px;
          width: auto; pointer-events: none;
        }
        .toast {
          display: flex; align-items: flex-start; gap: 8px; padding: 10px 10px 10px 12px;
          border: 1px solid var(--line); border-left: 4px solid var(--forest);
          border-radius: 10px; background: #FFFFFF; color: var(--ink);
          box-shadow: 0 10px 30px rgba(13, 74, 70, 0.16);
          font-size: 10px; line-height: 1.4; pointer-events: auto;
        }
        .toast.success { border-left-color: var(--lime-deep); }
        .toast.error { border-left-color: var(--danger); }
        .toast.info { border-left-color: var(--forest); }
        .toast-copy { min-width: 0; flex: 1; }
        .toast strong { display: block; margin-bottom: 2px; font-size: 10px; }
        .toast span { display: block; color: var(--muted); overflow-wrap: anywhere; }
        .toast-close {
          display: grid; place-items: center; width: 24px; height: 24px;
          flex: 0 0 auto; padding: 0; border: 0; border-radius: 50%;
          background: #F3F6F4; color: var(--muted); font-size: 14px;
          line-height: 1; cursor: pointer;
        }

        @media (min-width: 560px) {
          .wrap { width: min(calc(100% - 40px), 1180px); }
          .market-card { padding: 22px 22px 16px; border-radius: 22px; }
          .chart-svg { height: 148px; }
          .market-top { grid-template-columns: 1fr auto; align-items: end; }
          .market-side {
            display: block; min-width: 160px; padding-top: 0; border-top: 0;
            text-align: right;
          }
          .market-freshness { justify-content: flex-end; max-width: none; margin-top: 9px; }
          .balances { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          .trade-panel, .quote-panel, .history-panel { padding: 19px 18px 17px; }
          .toasts { left: auto; right: 16px; width: min(370px, calc(100vw - 32px)); }
          .demo-grid { grid-template-columns: 1fr 1fr; }
          .market-id { display: inline-flex; }
        }

        @media (min-width: 860px) {
          .topbar { padding: 20px 0 16px; }
          .brand-mark { width: 42px; height: 42px; }
          .brand-copy strong { font-size: 18px; }
          .brand-copy span { font-size: 10px; }
          .market-card { margin-bottom: 16px; padding: 26px 26px 17px; }
          .market-price { font-size: 54px; }
          .market-change { margin-top: 10px; font-size: 12px; }
          .market-side strong { font-size: 17px; }
          .chart-wrap { margin-top: 16px; }
          .chart-svg { height: 210px; }
          .market-footer { margin-top: 14px; }
          .balances { gap: 12px; margin-bottom: 16px; }
          .balance { padding: 15px 17px; }
          .trade-layout {
            grid-template-columns: minmax(0, 1.48fr) minmax(320px, 0.82fr);
            gap: 16px; align-items: start;
          }
          .quote-panel { position: sticky; top: 16px; }
          .trade-panel, .quote-panel, .history-panel { padding: 21px 20px 18px; }
          .panel h2 { font-size: 22px; }
          .history-panel { margin-top: 16px; }
          .demo-panel { margin-top: 16px; }
          .history-table-wrap { overflow: hidden; border: 1px solid var(--line); }
          .history-table thead { display: table-header-group; }
          .history-table th {
            padding: 10px 11px; border-bottom: 1px solid var(--line);
            background: #F6F9F6; color: var(--muted); text-align: left;
            font-size: 8px; font-weight: 800; letter-spacing: 0.07em;
            line-height: 1.25; text-transform: uppercase;
          }
          .history-table th:nth-child(1) { width: 14%; }
          .history-table th:nth-child(2) { width: 11%; }
          .history-table th:nth-child(3) { width: 11%; }
          .history-table th:nth-child(4) { width: 15%; }
          .history-table th:nth-child(5) { width: 13%; }
          .history-table th:nth-child(6) { width: 21%; }
          .history-table th:nth-child(7) { width: 15%; }
          .history-table tbody { display: table-row-group; }
          .history-table tr {
            display: table-row; border: 0; border-radius: 0; background: transparent;
          }
          .history-table td {
            display: table-cell; padding: 13px 11px;
            border-bottom: 1px solid #EDF1EE;
          }
          .history-table td::before { display: none; }
          .history-table td.history-trade {
            display: table-cell; padding: 13px 11px;
            background: transparent; border-bottom: 1px solid #EDF1EE;
          }
          .history-table .history-rate,
          .history-table .history-source,
          .history-table .history-receipt,
          .history-table .history-after { grid-column: auto; }
          .history-table tbody tr:last-child td { border-bottom: 0; }
          .history-table tbody tr:hover td { background: #FCFEFB; }
          .history-table td > strong { font-size: 11px; }
          .history-table .history-time {
            display: inline-block; margin-left: 6px; vertical-align: middle;
          }
          .history-table .history-receipt code { font-size: 8px; }
          .history-after-line { font-size: 9px; }
        }

        @media (min-width: 1080px) {
          .market-price { font-size: 58px; }
          .market-card { padding: 28px 30px 18px; }
          .trade-panel { padding: 23px 22px 20px; }
          .quote-panel { padding: 23px 22px 20px; }
          .amount-input { font-size: 36px; }
          .quote-seconds { font-size: 54px; }
          .side-tabs button { min-height: 48px; font-size: 14px; }
          .btn-primary { min-height: 52px; font-size: 13px; }
        }

        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
        }
      `}</style>

      <header className="topbar wrap">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
              <path d="M4 15.5 8.5 7h7L20 15.5 12 20 4 15.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M8.5 7 12 20l3.5-13" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" opacity=".7" />
            </svg>
          </span>
          <div className="brand-copy">
            <strong>Asasa</strong>
            <span>24K gold trading</span>
          </div>
        </div>
        <div className="topbar-meta">
          <span className="market-id">XAU / PKR</span>
          <span className={`status-chip ${statusTone}`}>
            <i aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
      </header>

      <main className="wrap">
        {error && (
          <div className="alert" role="alert">
            <strong>Something needs attention</strong>
            <span>{error}</span>
          </div>
        )}
        {state && !state.gate.ok && (
          <div className="alert" role="alert">
            <strong>{state.gate.message}</strong>
            {state.gate.hint && <span>{state.gate.hint}</span>}
          </div>
        )}

        {!state ? (
          <div className="loading-panel">
            <span className="spinner" aria-hidden="true" />
            Connecting to the gold market…
          </div>
        ) : (
          <>
            <h1 className="sr-only">Asasa 24K gold buy and sell market</h1>

            <section className="market-card" aria-label="Live gold market">
              <div className="market-top">
                <div>
                  <div className="market-eyebrow">
                    24K gold / PKR
                    <span className="market-live"><i aria-hidden="true" /> live</span>
                  </div>
                  <div className="market-price">
                    {currentMarket ? (
                      <>
                        {formatPkr(BigInt(currentMarket))}
                        <small>/g</small>
                      </>
                    ) : (
                      'Price unavailable'
                    )}
                  </div>
                  <div className="market-change">
                    <span className={`change-pill ${changeTone}`}>{changeText}</span>
                    <span>since first tracked point</span>
                  </div>
                </div>
                <div className="market-side">
                  <span className="market-side-label">Per tola</span>
                  <strong>{currentMarket ? ratePerTola(currentMarket) : '—'}</strong>
                  <div className="market-freshness">
                    <i aria-hidden="true" />
                    <span>
                      {state.price
                        ? `${state.price.source_label} · fetched ${age(state.price.fetch_age_seconds)}`
                        : state.price_notice?.message ?? 'No published price'}
                    </span>
                  </div>
                </div>
              </div>

              <PriceChart history={state.price_history} />

              <div className="market-footer">
                <span className="rate-pill">
                  Buy <strong>{state.price ? ratePerGram(state.price.buy_paisa_per_gram) : '—'}</strong>
                </span>
                <span className="rate-pill">
                  Sell <strong>{state.price ? ratePerGram(state.price.sell_paisa_per_gram) : '—'}</strong>
                </span>
                <span className="market-source">
                  {chartAge === null ? 'Freshness unknown' : `Updated ${age(chartAge)}`}
                </span>
              </div>
            </section>

            <section className="balances" aria-label="Your balances">
              <div className="balance">
                <span className="balance-label">Gold holdings</span>
                <strong>{formatGrams(userGold)}</strong>
                <small>{formatTola(userGold)}</small>
              </div>
              <div className="balance">
                <span className="balance-label">PKR cash</span>
                <strong>{formatPkr(walletPkr)}</strong>
                <small>Available to buy</small>
              </div>
              <div className="balance">
                <span className="balance-label">Gold value</span>
                <strong>{goldValue !== null ? formatPkr(goldValue) : '—'}</strong>
                <small>At the current sell rate</small>
              </div>
            </section>

            <div className="trade-layout">
              <section className="panel trade-panel" aria-labelledby="trade-heading">
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">Trade</span>
                    <h2 id="trade-heading">Buy or sell gold</h2>
                  </div>
                  <span className="head-note">Min Rs 1,000</span>
                </div>

                <div className="side-tabs" role="group" aria-label="Trade type">
                  <button
                    type="button"
                    data-side="buy"
                    className={side === 'buy' ? 'active' : ''}
                    aria-pressed={side === 'buy'}
                    onClick={() => chooseSide('buy')}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M8 12V4m0 0L4.5 7.5M8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Buy Gold
                  </button>
                  <button
                    type="button"
                    data-side="sell"
                    className={side === 'sell' ? 'active' : ''}
                    aria-pressed={side === 'sell'}
                    onClick={() => chooseSide('sell')}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M8 4v8m0 0 3.5-3.5M8 12 4.5 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Sell Gold
                  </button>
                </div>

                {side === 'buy' ? (
                  <>
                    <div className="field-head">
                      <span>You pay</span>
                      <span className="field-balance">Balance {formatPkr(walletPkr)}</span>
                    </div>
                    <label className="amount-box">
                      <span className="sr-only">Amount in PKR</span>
                      <span className="amount-line">
                        <span className="amount-prefix">Rs</span>
                        <input
                          className="amount-input"
                          value={buyInput}
                          onChange={(event) => setBuyInput(event.target.value)}
                          inputMode="decimal"
                          placeholder="5000.00"
                        />
                      </span>
                      <span className="field-foot">PKR · up to 2 decimal places</span>
                    </label>
                  </>
                ) : (
                  <>
                    <div className="field-head">
                      <span>You sell</span>
                      <div className="unit-switch" role="group" aria-label="Gold unit">
                        {(['gram', 'tola'] as const).map((unit) => (
                          <button
                            key={unit}
                            type="button"
                            className={sellUnit === unit ? 'on' : ''}
                            aria-pressed={sellUnit === unit}
                            onClick={() => changeSellUnit(unit)}
                          >
                            {unit === 'gram' ? 'Grams' : 'Tola'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="amount-box">
                      <span className="sr-only">Gold amount in {sellUnit === 'gram' ? 'grams' : 'tola'}</span>
                      <span className="amount-line">
                        <input
                          className="amount-input"
                          value={sellInput}
                          onChange={(event) => setSellInput(event.target.value)}
                          inputMode="decimal"
                          placeholder={sellUnit === 'gram' ? '1.000000' : '0.100000'}
                        />
                        <span className="amount-suffix">{sellUnit === 'gram' ? 'g' : 'tola'}</span>
                      </span>
                      <span className="field-foot">
                        Balance {formatGrams(userGold)} · {formatTola(userGold)}
                      </span>
                    </label>
                  </>
                )}

                {formError && <p className="form-error">{formError}</p>}

                <div className="order-preview">
                  {side === 'buy' ? (
                    <>
                      <div className="preview-highlight">
                        <span className="preview-label">Gold you receive</span>
                        <strong className="preview-value">
                          {buyGold !== null ? formatGrams(buyGold) : '—'}
                        </strong>
                        <span className="preview-sub">
                          {buyGold !== null ? formatTola(buyGold) : 'Calculated at the live buy rate'}
                        </span>
                      </div>
                      <div className="preview-rows">
                        <div className="preview-row">
                          <span>Total debit</span>
                          <strong>{buyCharged !== null ? formatPkr(buyCharged) : '—'}</strong>
                        </div>
                        <div className="preview-row">
                          <span>Buy rate</span>
                          <span>{buyPrice !== null ? ratePerGram(buyPrice.toString()) : '—'}</span>
                        </div>
                        <div className="preview-row">
                          <span>Per tola</span>
                          <span>{buyPrice !== null ? ratePerTola(buyPrice.toString()) : '—'}</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="preview-highlight">
                        <span className="preview-label">PKR you receive</span>
                        <strong className="preview-value">
                          {sellPkr !== null ? formatPkr(sellPkr) : '—'}
                        </strong>
                        <span className="preview-sub">
                          {sellGold !== null ? `${formatGrams(sellGold)} sold` : 'Calculated at the live sell rate'}
                        </span>
                      </div>
                      <div className="preview-rows">
                        <div className="preview-row">
                          <span>Gold amount</span>
                          <strong>
                            {sellGold !== null ? formatTola(sellGold) : '—'}
                          </strong>
                        </div>
                        <div className="preview-row">
                          <span>Sell rate</span>
                          <span>
                            {selectedUnitRate !== null
                              ? side === 'sell' && sellUnit === 'tola'
                                ? `${formatPkr(selectedUnitRate)}/tola`
                                : `${formatPkr(selectedUnitRate)}/g`
                              : '—'}
                          </span>
                        </div>
                        <div className="preview-row">
                          <span>Rate basis</span>
                          <span>{sellUnit === 'tola' ? '1 tola = 11.6638 g' : '24K gold per gram'}</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <details className="formula-note">
                  <summary>How this is calculated</summary>
                  <div className="formula-body">
                    <code>Buy: G = floor(PKR × 1e6 / buy rate)</code>
                    <code>Charged: ceil(G × buy rate / 1e6)</code>
                    <code>Sell: PKR = floor(gold × sell rate / 1e6)</code>
                    <p style={{ margin: '4px 0 0' }}>
                      Minimum Rs 1,000 or 0.1 g; maximum Rs 1,000,000 notional.
                      1 tola = 11.6638 g.
                    </p>
                  </div>
                </details>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={createQuote}
                  disabled={busy !== null || !state.gate.ok || quote !== null}
                >
                  {busy === 'action' ? 'Working…' : `Review ${side === 'buy' ? 'buy' : 'sell'} quote`}
                </button>
                <p className="action-hint">
                  {quote
                    ? 'Confirm or cancel the live quote before creating another.'
                    : `The rate is locked for ${quoteTtl}s after you continue.`}
                </p>
              </section>

              <aside className="panel quote-panel" aria-labelledby="quote-heading">
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">Review</span>
                    <h2 id="quote-heading">Live quote</h2>
                  </div>
                  {quote && (
                    <span className={`status-pill ${quoteReady ? 'ready' : 'live'}`}>
                      {quoteReady ? 'Ready' : 'Locked'}
                    </span>
                  )}
                </div>

                {quote ? (
                  <>
                    <div className="quote-meta-line">
                      <span className={`quote-side ${quote.side}`}>
                        {quote.side === 'buy' ? 'Buy' : 'Sell'} gold
                      </span>
                      <span className="head-note">
                        {quoteReady ? 'Countdown complete' : `${quoteSeconds}s remaining`}
                      </span>
                    </div>

                    <div className="quote-time">
                      <span className="quote-seconds">{quoteSeconds}</span>
                      <small>seconds</small>
                      <div className="quote-timer-copy">
                        <strong>{quoteReady ? 'Ready to confirm' : 'Confirm unlocks at zero'}</strong>
                        {quoteReady
                          ? 'The quote stays here until you decide.'
                          : 'Cancel is available at any time.'}
                      </div>
                    </div>
                    <div
                      className={`quote-progress ${quoteReady ? 'ready' : ''}`}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={quoteTtl}
                      aria-valuenow={Math.max(0, quoteTtl - quoteSeconds)}
                      aria-label="Quote review countdown"
                    >
                      <span style={{ width: `${quoteReady ? 100 : quoteProgress}%` }} />
                    </div>

                    <div className="quote-grid">
                      <div className="quote-cell">
                        <span>{quote.side === 'buy' ? 'You pay' : 'You receive'}</span>
                        <strong>{formatPkr(BigInt(quote.pkr_paisa))}</strong>
                      </div>
                      <div className="quote-cell">
                        <span>{quote.side === 'buy' ? 'You receive' : 'You sell'}</span>
                        <strong>{formatGrams(BigInt(quote.gold_micrograms))}</strong>
                        <small>{formatTola(BigInt(quote.gold_micrograms))}</small>
                      </div>
                      <div className="quote-cell">
                        <span>Locked rate</span>
                        <strong>{ratePerGram(quote.unit_paisa_per_gram)}</strong>
                        <small>{ratePerTola(quote.unit_paisa_per_gram)}</small>
                      </div>
                      <div className="quote-cell">
                        <span>Price source</span>
                        <strong>{quote.price_source}</strong>
                        <small>Receipt #{quote.id.slice(0, 8)}</small>
                      </div>
                    </div>

                    {quote.guardrail_applied && (
                      <p className="guardrail-note">The guardrail set this buy price.</p>
                    )}

                    <p className="quote-copy">
                      {quoteReady
                        ? 'Confirm executes at this locked rate. Cancel releases the quote without moving money.'
                        : `Confirm unlocks when the countdown reaches zero. The quote will not disappear — cancel any time before confirming.`}
                    </p>

                    <div className="quote-actions">
                      <button
                        type="button"
                        className="btn btn-forest btn-full"
                        onClick={() => confirmQuote(quote)}
                        disabled={!quoteReady || busy !== null}
                      >
                        {busy === 'action' ? 'Working…' : 'Confirm trade'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-full"
                        onClick={() => cancelQuote(quote)}
                        disabled={busy !== null || quote.status !== 'active'}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="quote-empty">
                    <p>
                      Lock the current rate before you trade. Nothing moves until you confirm.
                    </p>
                    <div className="quote-steps">
                      <div className="quote-step">
                        <b>1</b>
                        Choose Buy Gold or Sell Gold and enter an amount.
                      </div>
                      <div className="quote-step">
                        <b>2</b>
                        Continue to lock the rate for {quoteTtl} seconds.
                      </div>
                      <div className="quote-step">
                        <b>3</b>
                        Review, then confirm or cancel. The quote waits for you.
                      </div>
                    </div>
                  </div>
                )}
              </aside>
            </div>

            <section className="panel history-panel" aria-labelledby="history-heading">
              <div className="section-head">
                <div>
                  <span className="eyebrow">Settled trades</span>
                  <h2 id="history-heading">History</h2>
                </div>
                <span className="count-pill">
                  {state.trades.length} receipt{state.trades.length === 1 ? '' : 's'}
                </span>
              </div>

              {state.trades.length === 0 ? (
                <p className="history-empty">
                  No settled trades yet. Your first receipt will appear here after a confirmed
                  quote.
                </p>
              ) : (
                <div className="history-table-wrap">
                  <table className="history-table">
                    <caption className="sr-only">
                      Settled gold trades with amounts, execution rates and balances after
                      settlement.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Trade</th>
                        <th scope="col">Gold</th>
                        <th scope="col">Settlement</th>
                        <th scope="col">Execution rate</th>
                        <th scope="col">Source</th>
                        <th scope="col">Receipt ID</th>
                        <th scope="col">After settlement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.trades.map((trade) => {
                        const tradeGold = BigInt(trade.gold_micrograms);
                        const tradePkr = BigInt(trade.pkr_paisa);
                        const after = trade.balances_after;
                        const bought = trade.side === 'buy';
                        return (
                          <tr key={trade.id}>
                            <td className="history-trade">
                              <span className={`history-side ${trade.side}`}>
                                {bought ? 'Bought' : 'Sold'}
                              </span>
                              <time className="history-time" dateTime={trade.settled_at}>
                                {formatDateTime(trade.settled_at)}
                              </time>
                            </td>
                            <td data-label={bought ? 'Gold received' : 'Gold sold'}>
                              <strong>{formatGrams(tradeGold)}</strong>
                              <small>{formatTola(tradeGold)}</small>
                            </td>
                            <td data-label={bought ? 'PKR paid' : 'PKR received'}>
                              <strong>{formatPkr(tradePkr)}</strong>
                              <small>{bought ? 'Debited from cash' : 'Credited to cash'}</small>
                            </td>
                            <td className="history-rate" data-label="Execution rate">
                              <strong>{ratePerGram(trade.unit_paisa_per_gram)}</strong>
                              <small>
                                {ratePerTola(trade.unit_paisa_per_gram)} per tola
                              </small>
                            </td>
                            <td className="history-source" data-label="Price source">
                              <strong>{trade.source_label}</strong>
                            </td>
                            <td className="history-receipt" data-label="Receipt ID">
                              <code>{trade.id}</code>
                            </td>
                            <td className="history-after" data-label="After settlement">
                              <div className="history-after-list">
                                <span className="history-after-line">
                                  <span>Cash</span>
                                  <strong>{formatPkr(BigInt(after.pkr_paisa))}</strong>
                                </span>
                                <span className="history-after-line">
                                  <span>Gold</span>
                                  <strong>
                                    {formatGrams(BigInt(after.user_gold_micrograms))}
                                  </strong>
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <details className="demo-panel">
              <summary>
                <span>
                  <span className="demo-title">Demo controls</span>
                  <span className="demo-hint">Guardrail, timer, price sources and reset</span>
                </span>
                <span className="demo-chevron" aria-hidden="true">+</span>
              </summary>
              <div className="demo-body">
                <div className="demo-grid">
                  <div className="demo-block">
                    <h3>Guardrail</h3>
                    <label>
                      Buy price floor (PKR/gram)
                      <input
                        className="demo-input"
                        value={guardrail}
                        onChange={(event) => {
                          setGuardrailDirty(true);
                          setGuardrail(event.target.value);
                        }}
                        inputMode="decimal"
                        placeholder="0.00"
                      />
                    </label>
                    <div className="demo-actions" style={{ marginTop: 7 }}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => void applyGuardrail()}
                        disabled={busy !== null || guardrail.trim() === ''}
                      >
                        Apply guardrail
                      </button>
                    </div>
                    <p className="demo-note">
                      Current {formatPkr(BigInt(state.settings.guardrail_paisa_per_gram))}/g.
                      The buy formula is max(buy rate, guardrail); 0 disables it.
                    </p>
                  </div>

                  <div className="demo-block">
                    <h3>Price cycle</h3>
                    <div className="demo-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() =>
                          void demo(
                            'force',
                            'force-cycle',
                            {},
                            'Price cycle fetched',
                            'The price panel and chart now use the new cycle.',
                          )
                        }
                        disabled={busy !== null}
                      >
                        Fetch now
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() =>
                          void demo(
                            'reset',
                            'reset',
                            {},
                            'Demo reset',
                            'Balances are seeded and quotes/trades are cleared.',
                          )
                        }
                        disabled={busy !== null}
                      >
                        Reset demo
                      </button>
                    </div>
                  </div>

                  <div className="demo-block">
                    <h3>Quote timer</h3>
                    <div className="demo-actions">
                      {[2, 5, 75].map((seconds) => (
                        <button
                          key={seconds}
                          type="button"
                          className="btn btn-secondary"
                          onClick={() =>
                            void demo(
                              `ttl-${seconds}`,
                              'ttl',
                              { seconds },
                              `Timer set to ${seconds}s`,
                              'New quotes will use this countdown.',
                            )
                          }
                          disabled={busy !== null}
                        >
                          {seconds}s
                        </button>
                      ))}
                    </div>
                    <p className="demo-note">
                      Current: {state.settings.quote_ttl_seconds}s for new quotes.
                    </p>
                  </div>

                  <div className="demo-block">
                    <h3>Trading</h3>
                    <div className="demo-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() =>
                          void demo(
                            'pause',
                            'pause',
                            { on: !state.settings.force_paused },
                            state.settings.force_paused ? 'Trading resumed' : 'Trading paused',
                            'The gate is shared by the quote form and the API.',
                          )
                        }
                        disabled={busy !== null}
                      >
                        {state.settings.force_paused ? 'Resume trading' : 'Pause trading'}
                      </button>
                    </div>
                  </div>

                  <div className="demo-block">
                    <h3>Sources</h3>
                    <div className="demo-actions">
                      {(['a', 'b', 'c'] as const).map((source) => {
                        const on =
                          source === 'a'
                            ? state.settings.source_a_on
                            : source === 'b'
                              ? state.settings.source_b_on
                              : state.settings.source_c_on;
                        return (
                          <button
                            key={source}
                            type="button"
                            className="btn btn-secondary"
                            onClick={() =>
                              void demo(
                                `source-${source}`,
                                'toggle-source',
                                { source, on: !on },
                                `Source ${source.toUpperCase()} ${on ? 'off' : 'on'}`,
                                'The next price read refreshes the panel and chart.',
                              )
                            }
                            disabled={busy !== null}
                          >
                            {source.toUpperCase()} {on ? 'on' : 'off'}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </details>

            <footer className="page-foot">
              <span>
                Prices, quotes and receipts are server-owned. Polling{' '}
                <span className="mono">/api/state</span> every 2.5s.
              </span>
              <span>24K gold · PKR · 1 tola = 11.6638 g</span>
            </footer>
          </>
        )}
      </main>

      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div className={`toast ${toast.tone}`} key={toast.id}>
            <div className="toast-copy">
              <strong>{toast.title}</strong>
              {toast.message && <span>{toast.message}</span>}
            </div>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
