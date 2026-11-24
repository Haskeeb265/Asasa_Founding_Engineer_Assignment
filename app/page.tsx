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
    return <p className="empty">No published price has been recorded yet.</p>;
  }

  const width = 720;
  const height = 180;
  const padX = 8;
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
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Published gold price per gram over time"
      >
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={0}
            x2={width}
            y1={height - padY - fraction * (height - padY * 2)}
            y2={height - padY - fraction * (height - padY * 2)}
            stroke="#eef1f5"
            strokeWidth="1"
          />
        ))}
        {area ? <path d={area} fill="url(#chart-fill)" /> : null}
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#13202f" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#13202f" stopOpacity="0" />
          </linearGradient>
        </defs>
        {coords.length > 1 ? (
          <polyline
            points={line}
            fill="none"
            stroke="#13202f"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        <circle
          cx={coords[coords.length - 1].x}
          cy={coords[coords.length - 1].y}
          r="4.5"
          fill="#13202f"
          stroke="#fff"
          strokeWidth="2"
        />
        <text x={padX} y={14} className="chart-label">
          {formatPkr(BigInt(Math.round(max)))}
        </text>
        <text x={padX} y={height - 4} className="chart-label">
          {formatPkr(BigInt(Math.round(min)))}
        </text>
      </svg>
      <div className="chart-times">
        <span>{new Date(first.fetched_at).toLocaleTimeString()}</span>
        <span>{points.length} published point{points.length === 1 ? '' : 's'}</span>
        <span>{new Date(last.fetched_at).toLocaleTimeString()}</span>
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

  const pushToast = useCallback(
    (tone: ToastTone, title: string, message?: string) => {
      const id = ++toastId.current;
      setToasts((current) => [...current.slice(-3), { id, tone, title, message }]);
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, 6500);
    },
    [],
  );

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
    ? Math.max(
        0,
        Math.ceil((Date.parse(quote.expires_at) - (clock + serverOffset)) / 1000),
      )
    : 0;
  const quoteReady = quote?.status === 'active' && quoteSeconds === 0;

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
  const goldValue =
    currentMarket && state ? (userGold * BigInt(currentMarket)) / MICRO : null;
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
          `Receipt ${result.trade_id.slice(0, 8)} is in the trade history.`,
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
      `Buy price floor is Rs ${guardrail}/g. A value of 0 disables it.`,
    );
    if (ok) setGuardrailDirty(false);
  }

  const buyRate = side === 'buy' ? state?.price?.buy_paisa_per_gram : state?.price?.sell_paisa_per_gram;
  const visibleRate = buyRate ? BigInt(buyRate) : null;
  const selectedUnitRate =
    visibleRate !== null && side === 'sell' && sellUnit === 'tola'
      ? paisaPerTola(visibleRate)
      : visibleRate;

  return (
    <main className="wrap">
      <style>{`
        * { box-sizing: border-box; }
        .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 16px 80px; }
        .top { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
        h1 { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
        h2 { margin: 0 0 12px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: #5b6472; }
        h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #5b6472; }
        p { margin: 0; }
        .sub { color: #5b6472; font-size: 13px; margin-top: 6px; }
        .badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 6px 11px; font-size: 12px; font-weight: 600; }
        .ok { background: #e8f7ee; color: #146c36; }
        .bad { background: #fdecec; color: #a32121; }
        .warn { background: #fff4dd; color: #7a5300; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 16px; }
        .card { background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 18px; }
        .wallet { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 18px; margin-bottom: 16px; }
        .wallet-main { min-width: 220px; }
        .wallet-side { display: grid; grid-template-columns: repeat(2, minmax(130px, 1fr)); gap: 12px; min-width: 260px; }
        .wallet-side > div { background: #f7f8fa; border-radius: 8px; padding: 10px 12px; }
        .wallet-side span { display: block; color: #687180; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
        .wallet-side strong { font-size: 16px; }
        .kicker { display: block; color: #687180; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
        .big { font-size: 30px; font-weight: 700; letter-spacing: -0.03em; }
        .pos { color: #146c36; }
        .neg { color: #a32121; }
        .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .stat { background: #f7f8fa; border-radius: 8px; padding: 10px 12px; }
        .stat span { display: block; color: #687180; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
        .stat strong { font-size: 17px; }
        .price { font-size: 32px; font-weight: 700; letter-spacing: -0.03em; margin: 2px 0 4px; }
        .row { display: flex; justify-content: space-between; gap: 10px; padding: 7px 0; border-bottom: 1px solid #f0f2f5; font-size: 14px; }
        .row:last-child { border-bottom: 0; }
        .muted { color: #687180; }
        .small { font-size: 12px; }
        .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
        .banner { border-radius: 9px; padding: 11px 13px; margin-bottom: 14px; font-size: 14px; }
        .error { background: #fdecec; border: 1px solid #f3c6c6; color: #8f1d1d; }
        .form { display: grid; gap: 12px; }
        .toggle { display: flex; border: 1px solid #d8dce3; border-radius: 8px; overflow: hidden; }
        .toggle button { flex: 1; border: 0; background: #fff; padding: 9px 10px; cursor: pointer; font: inherit; font-size: 13px; }
        .toggle button + button { border-left: 1px solid #d8dce3; }
        .toggle button.on { background: #13202f; color: #fff; }
        label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
        input { border: 1px solid #cfd5df; border-radius: 8px; padding: 10px 11px; font: inherit; font-size: 15px; width: 100%; }
        input:focus { outline: 2px solid #9fc2ee; border-color: #6a9bd8; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        button.primary, button.secondary, button.danger { border-radius: 8px; padding: 9px 13px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
        button.primary { background: #13202f; color: #fff; border: 1px solid #13202f; }
        button.secondary { background: #fff; color: #243044; border: 1px solid #cfd5df; }
        button.danger { background: #fff; color: #a32121; border: 1px solid #e7bcbc; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .price-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
        .samples { margin-top: 12px; border-top: 1px solid #f0f2f5; padding-top: 8px; }
        .sample { display: grid; grid-template-columns: 92px 1fr auto; gap: 8px; padding: 6px 0; font-size: 12px; border-bottom: 1px solid #f7f8fa; }
        .sample:last-child { border-bottom: 0; }
        .tag { border-radius: 4px; padding: 1px 5px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
        .tag.accepted { background: #e8f7ee; color: #146c36; }
        .tag.rejected { background: #fdecec; color: #a32121; }
        .tag.selected { background: #e7eefc; color: #244d99; }
        .countdown { font-size: 30px; font-weight: 700; letter-spacing: -0.03em; }
        .quote-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0; }
        .quote-meta div { background: #f7f8fa; border-radius: 8px; padding: 9px 10px; }
        .quote-meta span { display: block; color: #687180; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
        .progress { height: 5px; border-radius: 999px; background: #edf0f4; overflow: hidden; margin: 6px 0 12px; }
        .progress > div { height: 100%; background: #13202f; transition: width 250ms linear; }
        .trades { display: grid; gap: 8px; }
        .trade { border: 1px solid #e7eaef; border-radius: 9px; padding: 10px 12px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-size: 13px; }
        details { background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 16px 18px; }
        summary { cursor: pointer; font-weight: 700; font-size: 14px; }
        .demo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 14px; }
        .empty { color: #687180; font-size: 14px; padding: 8px 0; }
        .options { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
        .option { text-align: left; border: 1px solid #d8dce3; background: #fff; border-radius: 12px; padding: 15px 16px; cursor: pointer; font: inherit; }
        .option strong { display: block; font-size: 17px; margin-bottom: 4px; }
        .option span { color: #687180; font-size: 12px; }
        .option.selected { border-color: #13202f; box-shadow: inset 0 0 0 1px #13202f; background: #f7f9fc; }
        .preview { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; background: #f7f8fa; border-radius: 9px; padding: 10px; }
        .preview > div { min-width: 0; }
        .preview span { display: block; color: #687180; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
        .preview strong { display: block; font-size: 15px; overflow-wrap: anywhere; }
        .preview small { display: block; color: #687180; font-size: 11px; margin-top: 2px; }
        .error-text { color: #a32121; font-size: 12px; }
        .chart-card { margin-bottom: 16px; }
        .chart-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: flex-start; }
        .chart-wrap { margin-top: 10px; }
        .chart-svg { display: block; width: 100%; height: 180px; }
        .chart-label { font-size: 10px; fill: #8a93a0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .chart-times { display: flex; justify-content: space-between; color: #8a93a0; font-size: 10px; margin-top: 2px; }
        .guardrail-box { background: #f7f8fa; border-radius: 9px; padding: 10px; display: grid; gap: 8px; }
        .toasts { position: fixed; right: 16px; bottom: 16px; z-index: 100; display: grid; gap: 8px; width: min(380px, calc(100vw - 32px)); }
        .toast { border-radius: 10px; padding: 11px 13px; box-shadow: 0 8px 30px rgba(19, 32, 47, 0.18); border: 1px solid; font-size: 13px; background: #fff; }
        .toast strong { display: block; font-size: 13px; margin-bottom: 2px; }
        .toast span { display: block; line-height: 1.35; }
        .toast.success { border-color: #bfe3cb; background: #f2fbf5; color: #146c36; }
        .toast.error { border-color: #f3c6c6; background: #fff5f5; color: #8f1d1d; }
        .toast.info { border-color: #cfe3fb; background: #f4f9ff; color: #174a7c; }
        @media (max-width: 560px) {
          .stats { grid-template-columns: 1fr; }
          .price { font-size: 27px; }
          .options { grid-template-columns: 1fr; }
          .wallet-side { grid-template-columns: 1fr; }
          .quote-meta, .preview { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className="top">
        <div>
          <h1>Asasa Gold</h1>
          <p className="sub">
            Buy PKR for gold, or sell gold for PKR against a server-locked quote.
          </p>
        </div>
        <div>
          {state ? (
            <span className={`badge ${state.gate.ok ? 'ok' : 'bad'}`}>
              {state.gate.ok ? 'Trading open' : state.gate.code ?? 'Trading closed'}
            </span>
          ) : (
            <span className="badge warn">Loading…</span>
          )}
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {state && !state.gate.ok && (
        <div className="banner error">
          <strong>{state.gate.message}</strong>
          {state.gate.hint ? ` ${state.gate.hint}` : ''}
        </div>
      )}

      {!state ? (
        <div className="card empty">Connecting to the trading API…</div>
      ) : (
        <>
          <section className="card wallet">
            <div className="wallet-main">
              <span className="kicker">Your gold balance</span>
              <div className="big">{formatGrams(userGold)}</div>
              <p className="small muted" style={{ marginTop: 4 }}>
                {goldValue !== null
                  ? `Current value ${formatPkr(goldValue)} at the sell price`
                  : 'Current value unavailable until a price is published'}
              </p>
            </div>
            <div className="wallet-side">
              <div>
                <span>PKR balance</span>
                <strong>{formatPkr(walletPkr)}</strong>
              </div>
              <div>
                <span>Price change</span>
                <strong
                  className={
                    priceChangePct === null
                      ? ''
                      : priceChangePct >= 0
                        ? 'pos'
                        : 'neg'
                  }
                >
                  {priceChangePct === null
                    ? '—'
                    : `${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%`}
                </strong>
                <span style={{ textTransform: 'none', letterSpacing: 0 }}>
                  since first tracked point
                </span>
              </div>
            </div>
          </section>

          <div className="options" role="group" aria-label="Trade type">
            <button
              type="button"
              className={`option ${side === 'buy' ? 'selected' : ''}`}
              onClick={() => chooseSide('buy')}
            >
              <strong>Buy Gold</strong>
              <span>Enter PKR. We calculate the gold at the live buy rate.</span>
            </button>
            <button
              type="button"
              className={`option ${side === 'sell' ? 'selected' : ''}`}
              onClick={() => chooseSide('sell')}
            >
              <strong>Sell Gold</strong>
              <span>Enter gold in grams or tola. We calculate the PKR proceeds.</span>
            </button>
          </div>

          <section className="card chart-card">
            <div className="chart-head">
              <div>
                <h2>Gold price per gram</h2>
                <div className="price">
                  {currentMarket ? ratePerGram(currentMarket) : 'No price'}
                </div>
                <p className="small muted">
                  {state.price
                    ? `${state.price.source_label} · fetched ${age(state.price.fetch_age_seconds)}`
                    : state.price_notice?.message ?? 'No published price is available.'}
                </p>
              </div>
              <div className="small muted" style={{ textAlign: 'right' }}>
                <div>Per tola: {currentMarket ? ratePerTola(currentMarket) : '—'}</div>
                <div>
                  Last fetch:{' '}
                  {chartAge === null ? '—' : age(chartAge)}
                </div>
              </div>
            </div>
            <PriceChart history={state.price_history} />
            {state.price && (
              <div className="row">
                <span className="muted">Buy / sell rate</span>
                <strong>
                  {ratePerGram(state.price.buy_paisa_per_gram)} /{' '}
                  {ratePerGram(state.price.sell_paisa_per_gram)}
                </strong>
              </div>
            )}
          </section>

          <div className="grid">
            <section className="card">
              <h2>{side === 'buy' ? 'Buy Gold' : 'Sell Gold'}</h2>
              <div className="form">
                {side === 'buy' ? (
                  <label>
                    Amount in PKR
                    <input
                      value={buyInput}
                      onChange={(event) => setBuyInput(event.target.value)}
                      inputMode="decimal"
                      placeholder="5000.00"
                    />
                  </label>
                ) : (
                  <>
                    <div className="toggle" role="group" aria-label="Gold unit">
                      {(['gram', 'tola'] as const).map((unit) => (
                        <button
                          key={unit}
                          type="button"
                          className={sellUnit === unit ? 'on' : ''}
                          onClick={() => changeSellUnit(unit)}
                        >
                          {unit === 'gram' ? 'Grams' : 'Tola'}
                        </button>
                      ))}
                    </div>
                    <label>
                      Gold amount ({sellUnit === 'gram' ? 'grams' : 'tola'})
                      <input
                        value={sellInput}
                        onChange={(event) => setSellInput(event.target.value)}
                        inputMode="decimal"
                        placeholder={sellUnit === 'gram' ? '1.000000' : '0.100000'}
                      />
                    </label>
                  </>
                )}

                <div className="preview">
                  {side === 'buy' ? (
                    <>
                      <div>
                        <span>You pay</span>
                        <strong>{buyCharged !== null ? formatPkr(buyCharged) : '—'}</strong>
                        <small>{buyRate ? ratePerGram(buyRate) : 'Price unavailable'}</small>
                      </div>
                      <div>
                        <span>You receive</span>
                        <strong>{buyGold !== null ? formatGrams(buyGold) : '—'}</strong>
                        <small>{buyGold !== null ? formatTola(buyGold) : 'Calculated live'}</small>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <span>You sell</span>
                        <strong>{sellGold !== null ? formatGrams(sellGold) : '—'}</strong>
                        <small>
                          {sellGold !== null ? formatTola(sellGold) : 'Calculated live'}
                        </small>
                      </div>
                      <div>
                        <span>You receive</span>
                        <strong>{sellPkr !== null ? formatPkr(sellPkr) : '—'}</strong>
                        <small>
                          {sellUnit === 'tola' && selectedUnitRate !== null
                            ? `${formatPkr(selectedUnitRate)}/tola`
                            : buyRate
                              ? ratePerGram(buyRate)
                              : 'Price unavailable'}
                        </small>
                      </div>
                    </>
                  )}
                </div>

                <div className="row">
                  <span className="muted">Current {side === 'buy' ? 'buy' : 'sell'} rate</span>
                  <strong>
                    {selectedUnitRate === null
                      ? '—'
                      : side === 'sell' && sellUnit === 'tola'
                        ? `${formatPkr(selectedUnitRate)}/tola`
                        : `${formatPkr(selectedUnitRate)}/g`}
                  </strong>
                </div>

                {formError && <p className="error-text">{formError}</p>}
                <p className="small muted">
                  Buy: `G = floor(PKR × 1e6 / buy rate)`, charged `ceil(G × buy rate /
                  1e6)`. Sell: `PKR = floor(gold × sell rate / 1e6)`. Minimum Rs
                  1,000 or 0.1 g; maximum Rs 1,000,000 notional. 1 tola = 11.6638 g.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={createQuote}
                    disabled={busy !== null || !state.gate.ok || quote !== null}
                  >
                    {busy === 'action' ? 'Working…' : 'Continue'}
                  </button>
                  {quote && (
                    <span className="small muted">
                      Confirm or cancel the live quote before creating another.
                    </span>
                  )}
                </div>
              </div>
            </section>

            <section className="card">
              <h2>Live quote</h2>
              {quote ? (
                <>
                  <div className="price-head">
                    <span
                      className={`badge ${
                        quote.status === 'confirmed'
                          ? 'warn'
                          : quoteReady
                            ? 'ok'
                            : 'warn'
                      }`}
                    >
                      {quote.side === 'buy' ? 'Buy' : 'Sell'} · {quote.status}
                    </span>
                    <span className="small muted">
                      {quoteReady
                        ? 'countdown complete'
                        : `${quoteSeconds}s until confirm unlocks`}
                    </span>
                  </div>
                  <div className="countdown">{quoteSeconds}s</div>
                  <div className="progress">
                    <div
                      style={{
                        width: `${Math.min(
                          100,
                          (quoteSeconds / Math.max(1, state.settings.quote_ttl_seconds)) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                  <div className="quote-meta">
                    <div>
                      <span>{quote.side === 'buy' ? 'You pay' : 'You receive'}</span>
                      <strong>{formatPkr(BigInt(quote.pkr_paisa))}</strong>
                    </div>
                    <div>
                      <span>{quote.side === 'buy' ? 'You receive' : 'You sell'}</span>
                      <strong>{formatGrams(BigInt(quote.gold_micrograms))}</strong>
                      <span style={{ textTransform: 'none', letterSpacing: 0 }}>
                        {formatTola(BigInt(quote.gold_micrograms))}
                      </span>
                    </div>
                    <div>
                      <span>Locked rate</span>
                      <strong>{ratePerGram(quote.unit_paisa_per_gram)}</strong>
                      <span style={{ textTransform: 'none', letterSpacing: 0 }}>
                        {ratePerTola(quote.unit_paisa_per_gram)}
                      </span>
                    </div>
                    <div>
                      <span>Price source</span>
                      <strong className="mono">{quote.price_source}</strong>
                    </div>
                  </div>
                  {quote.guardrail_applied && (
                    <p className="small warn">The guardrail set this buy price.</p>
                  )}
                  <p className="small muted">
                    {quoteReady
                      ? 'The timer has finished. Confirm to execute, or cancel. The quote stays here until you do.'
                      : 'Review the locked amounts. Confirm unlocks when the countdown reaches zero; cancel is available until you confirm.'}
                  </p>
                  <div className="actions" style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => confirmQuote(quote)}
                      disabled={!quoteReady || busy !== null}
                    >
                      {busy === 'action' ? 'Working…' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => cancelQuote(quote)}
                      disabled={busy !== null}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <p className="empty">
                  No live quote. Choose Buy Gold or Sell Gold, enter an amount, and press
                  Continue. The quote stays here until you confirm or cancel it.
                </p>
              )}
            </section>
          </div>

          <section className="card" style={{ marginBottom: 16 }}>
            <h2>Recent trades</h2>
            {state.trades.length === 0 ? (
              <p className="empty">No settled trades yet.</p>
            ) : (
              <div className="trades">
                {state.trades.map((trade) => (
                  <div className="trade" key={trade.id}>
                    <span>
                      <strong>{trade.side === 'buy' ? 'Bought' : 'Sold'}</strong>{' '}
                      {formatGrams(BigInt(trade.gold_micrograms))} (
                      {formatTola(BigInt(trade.gold_micrograms))}) for{' '}
                      {formatPkr(BigInt(trade.pkr_paisa))}
                    </span>
                    <span className="muted small">
                      {ratePerGram(trade.unit_paisa_per_gram)} · {trade.source_label} ·{' '}
                      {new Date(trade.settled_at).toLocaleTimeString()} ·{' '}
                      <span className="mono">{trade.id.slice(0, 8)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <details>
            <summary>Demo controls</summary>
            <div className="demo-grid">
              <div>
                <h3>Guardrail</h3>
                <div className="guardrail-box">
                  <label>
                    Buy price floor (PKR/gram)
                    <input
                      value={guardrail}
                      onChange={(event) => {
                        setGuardrailDirty(true);
                        setGuardrail(event.target.value);
                      }}
                      inputMode="decimal"
                      placeholder="0.00"
                    />
                  </label>
                  <div className="actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void applyGuardrail()}
                      disabled={busy !== null || guardrail.trim() === ''}
                    >
                      Apply guardrail
                    </button>
                  </div>
                  <p className="small muted">
                    Current: {formatPkr(BigInt(state.settings.guardrail_paisa_per_gram))}/g.
                    The buy formula is max(buy rate, guardrail); 0 disables it.
                  </p>
                </div>
              </div>

              <div>
                <h3>Price cycle</h3>
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
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
                    className="secondary"
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

              <div>
                <h3>Quote timer</h3>
                <div className="actions">
                  {[2, 5, 75].map((seconds) => (
                    <button
                      key={seconds}
                      type="button"
                      className="secondary"
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
                <p className="small muted" style={{ marginTop: 6 }}>
                  Current: {state.settings.quote_ttl_seconds}s for new quotes.
                </p>
              </div>

              <div>
                <h3>Trading</h3>
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
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

              <div>
                <h3>Sources</h3>
                <div className="actions">
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
                        className="secondary"
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
          </details>

          <p className="small muted" style={{ marginTop: 16 }}>
            Polling <span className="mono">/api/state</span> every 2.5s. Prices, quotes and
            receipts are server-owned; this page never settles a trade itself.
          </p>
        </>
      )}

      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div className={`toast ${toast.tone}`} key={toast.id}>
            <strong>{toast.title}</strong>
            {toast.message && <span>{toast.message}</span>}
          </div>
        ))}
      </div>
    </main>
  );
}
