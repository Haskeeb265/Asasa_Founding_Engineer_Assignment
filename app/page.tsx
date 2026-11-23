'use client';

import { useCallback, useEffect, useState } from 'react';

type Side = 'buy' | 'sell';
type InputMode = 'pkr' | 'grams';

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

interface Quote {
  id: string;
  side: Side;
  status: 'active' | 'confirmed' | 'settled' | 'expired' | 'cancelled' | 'rejected';
  input_mode: InputMode;
  input_minor: string;
  market_paisa_per_gram: string;
  unit_paisa_per_gram: string;
  spread_bps: number;
  gold_micrograms: string;
  pkr_paisa: string;
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
    throw new Error(message || `Request failed (HTTP ${response.status}).`);
  }
  return data as T;
}

function formatMinor(value: string, decimals: number, trim = false): string {
  const number = BigInt(value);
  const negative = number < 0n;
  const absolute = negative ? -number : number;
  const base = 10n ** BigInt(decimals);
  const whole = (absolute / base)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let fraction = (absolute % base).toString().padStart(decimals, '0');
  if (trim) fraction = fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function pkr(paisa: string): string {
  return `Rs ${formatMinor(paisa, 2)}`;
}

function grams(micrograms: string): string {
  return `${formatMinor(micrograms, 6, true)} g`;
}

function rate(paisaPerGram: string): string {
  return `${pkr(paisaPerGram)}/g`;
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

const SIDES: Side[] = ['buy', 'sell'];
const MODES: InputMode[] = ['pkr', 'grams'];

export default function Page() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [side, setSide] = useState<Side>('buy');
  const [mode, setMode] = useState<InputMode>('pkr');
  const [input, setInput] = useState('5000.00');

  const refresh = useCallback(async (quiet = false) => {
    try {
      const next = await api<AppState>('/api/state');
      setState(next);
      if (!quiet) setError(null);
      return next;
    } catch (caught) {
      if (!quiet) setError(errorMessage(caught));
      return null;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const next = await api<AppState>('/api/state');
        if (!stopped) {
          setState(next);
          setError(null);
        }
      } catch (caught) {
        if (!stopped) setError(errorMessage(caught));
      }
    };
    void tick();
    const timer = window.setInterval(tick, 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setInput(mode === 'pkr' ? '5000.00' : '0.100000');
  }, [mode]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function createQuote() {
    return run('quote', async () => {
      const result = await api<{ quote: Quote }>('/api/quotes', {
        method: 'POST',
        body: JSON.stringify({ side, input_mode: mode, input }),
      });
      setNotice(
        `Quote locked for ${result.quote.seconds_remaining}s at ${rate(
          result.quote.unit_paisa_per_gram,
        )}. Confirm it before the timer ends.`,
      );
      await refresh(true);
    });
  }

  function confirmQuote(quote: Quote) {
    return run('confirm', async () => {
      await api(`/api/quotes/${quote.id}/confirm`, { method: 'POST' });
      setNotice('Confirmed. The trade settles when the server timer runs out.');
      await refresh(true);
    });
  }

  function cancelQuote(quote: Quote) {
    return run('cancel', async () => {
      await api(`/api/quotes/${quote.id}/cancel`, { method: 'POST' });
      setNotice('Quote cancelled.');
      await refresh(true);
    });
  }

  function demo(label: string, path: string, body: unknown = {}) {
    return run(label, async () => {
      await api(`/api/demo/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setNotice(`${path.replace(/-/g, ' ')} applied.`);
      await refresh(true);
    });
  }

  const quote = state?.quote ?? null;
  const recentTrades = state?.trades.slice(0, 6) ?? [];

  return (
    <main className="wrap">
      <style>{`
        * { box-sizing: border-box; }
        .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 16px 64px; }
        .top { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
        h1 { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
        h2 { margin: 0 0 12px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: #5b6472; }
        p { margin: 0; }
        .sub { color: #5b6472; font-size: 13px; margin-top: 6px; }
        .badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 6px 11px; font-size: 12px; font-weight: 600; }
        .ok { background: #e8f7ee; color: #146c36; }
        .bad { background: #fdecec; color: #a32121; }
        .warn { background: #fff4dd; color: #7a5300; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 16px; }
        .card { background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 18px; }
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
        .notice { background: #eef6ff; border: 1px solid #cfe3fb; color: #174a7c; }
        .form { display: grid; gap: 12px; }
        .toggle { display: flex; border: 1px solid #d8dce3; border-radius: 8px; overflow: hidden; }
        .toggle button { flex: 1; border: 0; background: #fff; padding: 9px 10px; cursor: pointer; font: inherit; font-size: 13px; }
        .toggle button + button { border-left: 1px solid #d8dce3; }
        .toggle button.on { background: #13202f; color: #fff; }
        label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
        input { border: 1px solid #cfd5df; border-radius: 8px; padding: 10px 11px; font: inherit; font-size: 15px; width: 100%; }
        input:focus { outline: 2px solid #9fc2ee; border-color: #6a9bd8; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; }
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
        .trades { display: grid; gap: 8px; }
        .trade { border: 1px solid #e7eaef; border-radius: 9px; padding: 10px 12px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-size: 13px; }
        details { background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 16px 18px; }
        summary { cursor: pointer; font-weight: 700; font-size: 14px; }
        .demo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 14px; }
        .demo-grid h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #5b6472; }
        .empty { color: #687180; font-size: 14px; padding: 8px 0; }
        @media (max-width: 560px) {
          .stats { grid-template-columns: 1fr; }
          .price { font-size: 27px; }
        }
      `}</style>

      <div className="top">
        <div>
          <h1>Asasa Gold — Test Console</h1>
          <p className="sub">
            Create a quote, confirm it, and watch the server timer settle the trade.
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
      {notice && <div className="banner notice">{notice}</div>}
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
          <div className="grid">
            <section className="card">
              <h2>Balances</h2>
              <div className="stats">
                <div className="stat">
                  <span>PKR cash</span>
                  <strong>{pkr(state.balances.pkr_paisa)}</strong>
                </div>
                <div className="stat">
                  <span>Your gold</span>
                  <strong>{grams(state.balances.user_gold_micrograms)}</strong>
                </div>
                <div className="stat">
                  <span>Platform gold</span>
                  <strong>{grams(state.balances.platform_gold_micrograms)}</strong>
                </div>
              </div>
              <p className="small muted" style={{ marginTop: 10 }}>
                Total gold in the demo: {grams(state.balances.total_gold_micrograms)}
              </p>
            </section>

            <section className="card">
              <h2>Price</h2>
              {state.price ? (
                <>
                  <div className="price">{rate(state.price.market_paisa_per_gram)}</div>
                  <div className="price-head">
                    <span className={`badge ${state.price.degraded ? 'warn' : 'ok'}`}>
                      {state.price.status}
                      {state.price.degraded ? ` · ${state.price.degraded_reason ?? 'degraded'}` : ''}
                    </span>
                    <span className="small muted">
                      {state.price.source_label} · fetched {age(state.price.fetch_age_seconds)}
                    </span>
                  </div>
                  <div className="row">
                    <span>You buy at</span>
                    <strong>{rate(state.price.buy_paisa_per_gram)}</strong>
                  </div>
                  <div className="row">
                    <span>You sell at</span>
                    <strong>{rate(state.price.sell_paisa_per_gram)}</strong>
                  </div>
                  {state.price.guardrail_applied && (
                    <p className="small warn" style={{ marginTop: 6 }}>
                      Guardrail applied to the buy price.
                    </p>
                  )}
                  <div className="samples">
                    {state.price.samples.map((sample) => (
                      <div className="sample" key={sample.source}>
                        <span className="mono">{sample.source}</span>
                        <span>
                          {sample.price_paisa_per_gram
                            ? rate(sample.price_paisa_per_gram)
                            : 'no price'}{' '}
                          <span className="muted">· {sample.reason}</span>
                          {sample.note ? (
                            <span className="muted"> · {sample.note}</span>
                          ) : null}
                        </span>
                        <span style={{ display: 'flex', gap: 4 }}>
                          {sample.accepted ? (
                            <span className="tag accepted">ok</span>
                          ) : (
                            <span className="tag rejected">no</span>
                          )}
                          {sample.selected ? <span className="tag selected">used</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="empty">
                  {state.price_notice?.message ?? 'No price is available right now.'}
                </p>
              )}
            </section>
          </div>

          <div className="grid">
            <section className="card">
              <h2>New quote</h2>
              <div className="form">
                <div className="toggle" role="group" aria-label="Side">
                  {SIDES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={side === value ? 'on' : ''}
                      onClick={() => setSide(value)}
                    >
                      {value === 'buy' ? 'Buy gold' : 'Sell gold'}
                    </button>
                  ))}
                </div>
                <div className="toggle" role="group" aria-label="Input unit">
                  {MODES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={mode === value ? 'on' : ''}
                      onClick={() => setMode(value)}
                    >
                      {value === 'pkr' ? 'PKR amount' : 'Gold grams'}
                    </button>
                  ))}
                </div>
                <label>
                  {mode === 'pkr' ? 'PKR amount' : 'Gold amount (grams)'}
                  <input
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    inputMode="decimal"
                    placeholder={mode === 'pkr' ? '5000.00' : '0.100000'}
                  />
                </label>
                <p className="small muted">
                  Minimum {mode === 'pkr' ? 'Rs 1,000.00' : '0.100000 g'} · maximum
                  Rs 1,000,000 notional. The quote locks the rate; confirmation
                  settles after the timer.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={createQuote}
                    disabled={busy !== null || !state.gate.ok}
                  >
                    {busy === 'quote' ? 'Getting quote…' : 'Get quote'}
                  </button>
                </div>
              </div>
            </section>

            <section className="card">
              <h2>Live quote</h2>
              {quote ? (
                <>
                  <div className="price-head">
                    <span className={`badge ${quote.status === 'confirmed' ? 'warn' : 'ok'}`}>
                      {quote.side} · {quote.status}
                    </span>
                    <span className="small muted">
                      locked {quote.seconds_remaining}s remaining
                    </span>
                  </div>
                  <div className="countdown">{Math.max(0, quote.seconds_remaining)}s</div>
                  <div className="quote-meta">
                    <div>
                      <span>You pay</span>
                      <strong>{pkr(quote.pkr_paisa)}</strong>
                    </div>
                    <div>
                      <span>You receive</span>
                      <strong>{grams(quote.gold_micrograms)}</strong>
                    </div>
                    <div>
                      <span>Locked rate</span>
                      <strong>{rate(quote.unit_paisa_per_gram)}</strong>
                    </div>
                    <div>
                      <span>Price source</span>
                      <strong className="mono">{quote.price_source}</strong>
                    </div>
                  </div>
                  {quote.status === 'confirmed' && (
                    <p className="small muted">
                      Confirmed. The server settles it when the timer reaches zero; this
                      page polls automatically.
                    </p>
                  )}
                  <div className="actions" style={{ marginTop: 12 }}>
                    {quote.status === 'active' && (
                      <button
                        type="button"
                        className="primary"
                        onClick={() => confirmQuote(quote)}
                        disabled={busy !== null}
                      >
                        {busy === 'confirm' ? 'Confirming…' : 'Confirm quote'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="danger"
                      onClick={() => cancelQuote(quote)}
                      disabled={busy !== null}
                    >
                      {busy === 'cancel' ? 'Cancelling…' : 'Cancel quote'}
                    </button>
                  </div>
                </>
              ) : (
                <p className="empty">
                  No live quote. Create one on the left; it stays locked until confirmed,
                  cancelled, or expired.
                </p>
              )}
            </section>
          </div>

          <section className="card" style={{ marginBottom: 16 }}>
            <h2>Recent trades</h2>
            {recentTrades.length === 0 ? (
              <p className="empty">No settled trades yet. Confirm a quote and wait for its timer.</p>
            ) : (
              <div className="trades">
                {recentTrades.map((trade) => (
                  <div className="trade" key={trade.id}>
                    <span>
                      <strong>{trade.side === 'buy' ? 'Bought' : 'Sold'}</strong>{' '}
                      {grams(trade.gold_micrograms)} for {pkr(trade.pkr_paisa)}
                    </span>
                    <span className="muted small">
                      {rate(trade.unit_paisa_per_gram)} · {trade.source_label} ·{' '}
                      {new Date(trade.settled_at).toLocaleTimeString()}
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
                <h3>Price cycle</h3>
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => demo('force', 'force-cycle')}
                    disabled={busy !== null}
                  >
                    {busy === 'force' ? 'Fetching…' : 'Fetch now'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => demo('reset', 'reset')}
                    disabled={busy !== null}
                  >
                    {busy === 'reset' ? 'Resetting…' : 'Reset demo'}
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
                      onClick={() => demo(`ttl-${seconds}`, 'ttl', { seconds })}
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
                      demo('pause', 'pause', { on: !state.settings.force_paused })
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
                          demo(`source-${source}`, 'toggle-source', { source, on: !on })
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
            Polling <span className="mono">/api/state</span> every 2.5s. The server
            clock and database are authoritative; this page never settles a trade
            itself.
          </p>
        </>
      )}
    </main>
  );
}
