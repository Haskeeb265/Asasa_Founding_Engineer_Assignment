"use client";

/**
 * User page: the trade flow and the operator settings.
 * Screens: achromatic-ledger wallet pattern; this page answers
 * "Can I buy or sell gold right now, and what will it cost?" first.
 *
 * The client never does money arithmetic beyond calling domain/trade-math
 * (the same pure functions the server calls) on wire numbers and formatting:
 * parse / preview / derived prices all go through domain/.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "./chrome";
import { formatMicrograms, formatPaisa, parseGoldAmount, parsePkrAmount } from "../domain/units";
import {
  buildQuote,
  buyUnitPaisaPerGram,
  sellUnitPaisaPerGram,
} from "../domain/trade-math";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

/* ------------------------------------------------------------- types */

type BalancesWire = {
  pkr_paisa: number;
  user_gold_micrograms: number;
  platform_gold_micrograms: number;
  pkr_display: string;
  user_gold_display: string;
  platform_gold_display: string;
};

type PriceWire = {
  price_paisa_per_gram: number | null;
  price_display: string | null;
  source: string | null;
  confidence: string;
  degraded: boolean;
  overridden: boolean;
  cycle_id: string | null;
  fetched_at: string;
  provider_at: string | null;
  market_age_seconds: number | null;
  fetch_age_seconds: number;
  reason: string | null;
  samples: Array<{
    source: string;
    ok: boolean;
    accepted: boolean;
    selected: boolean;
    reason: string | null;
    price_paisa_per_gram: number | null;
    price_display: string | null;
  }>;
};

type QuoteWire = {
  id: string;
  side: string;
  status: string;
  input_mode: string;
  input_minor: number;
  market_paisa_per_gram: number;
  unit_paisa_per_gram: number;
  spread_bps: number;
  gold_micrograms: number;
  pkr_paisa: number;
  unit_display: string;
  guardrail_applied: boolean;
  price_source: string;
  price_fetched_at: string;
  expires_at: string;
  created_at: string;
  now?: string;
};

type TradeWire = {
  id: string;
  quote_id: string;
  side: string;
  gold_micrograms: number;
  pkr_paisa: number;
  gold_display: string;
  pkr_display: string;
  unit_display: string;
  market_display: string;
  guardrail_applied: boolean;
  price_source: string;
  settled_at: string;
  quote_created_at: string;
  balances_after?: BalancesWire | null;
  balances_before?: BalancesWire | null;
};

type SettingsWire = {
  guardrail_paisa_per_gram: number;
  quote_ttl_seconds: number;
  divergence_threshold_bps: number;
  max_price_age_seconds: number;
  price_fetch_interval_seconds: number;
  source_a_on: boolean;
  source_b_on: boolean;
  source_c_on: boolean;
  source_c_basis_bps: number;
  price_override_paisa: number | null;
  force_paused: boolean;
};

type State = {
  now: string;
  balances: BalancesWire | null;
  price: PriceWire | null;
  price_notice: string | null;
  active_quote: QuoteWire | null;
  trades: TradeWire[];
  settings: SettingsWire | null;
};

type Toast = { id: number; kind: "ok" | "warn" | "error"; text: string };

/* ------------------------------------------------------------- page */

export default function Page() {
  return (
    <AppShell title="Trade" sub="Buy with your PKR wallet or sell your 24K gold at the live market price.">
      <TradePage />
    </AppShell>
  );
}

function TradePage() {
  const [state, setState] = useState<State | null>(null);
  const [quote, setQuote] = useState<QuoteWire | null>(null);
  const [receipt, setReceipt] = useState<TradeWire | null>(null);

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");

  // Toast notifications: every one-shot user communication (trade settled,
  // quote cancelled, pause engaged, refusals) lives here instead of inline
  // notices, so the message lands exactly once and fades itself away.
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = ++toastSeq.current;
    setToasts((list) => [...list, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, 4800);
  }, []);

  // The id of the quote we confirmed, kept until its settlement receipt
  // arrives in the polled state — confirm does not execute the trade.
  const pendingQuoteId = useRef<string | null>(null);

  // In-flight guards: a fast double click must not create two quotes, and a
  // press while a confirm/cancel is still round-tripping must not fire a
  // second request whose outcome the user has not seen yet.
  const creatingRef = useRef(false);
  const confirmingRef = useRef(false);

  const refetch = useCallback(() => {
    fetch(`${API}/api/state`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json && !json.error) setState(json as State);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refetch();
    const t = setInterval(refetch, 5000);
    return () => clearInterval(t);
  }, [refetch]);

  // Adopt a quote left active or confirmed by another tab or a reload — never
  // one whose timer already ran out; the server sweeps those on every read.
  const serverQuote = state?.active_quote ?? null;
  useEffect(() => {
    if (!serverQuote) return;
    if (new Date(serverQuote.expires_at).getTime() <= Date.now()) return;
    if (!quote) setQuote(serverQuote);
  }, [serverQuote, quote]);

  const settings = state?.settings ?? null;
  const balances = state?.balances ?? null;
  const price = state?.price ?? null;
  const marketPaisaPerGram = useMemo(
    () => (price?.price_paisa_per_gram != null ? BigInt(price.price_paisa_per_gram) : null),
    [price],
  );

  /* -------- validation: runtime checks on the amount the user types -------- */

  const check = useMemo(() => {
    const raw = amount.trim();
    if (raw === "") return { parsed: null as bigint | null, problem: null as string | null };

    const parsed =
      side === "buy" ? parsePkrAmount(raw) : parseGoldAmount(raw);
    if (!parsed.ok) return { parsed: null, problem: parsed.message };
    const inputMinor = parsed.value;

    if (marketPaisaPerGram === null || balances === null) {
      return { parsed: null, problem: "No live price, so trading is disabled." };
    }

    const quoteEstimate = buildQuote({
      side,
      inputMode: side === "buy" ? "pkr" : "gold",
      inputMinor,
      marketPaisaPerGram,
      guardrailPaisaPerGram: BigInt(settings?.guardrail_paisa_per_gram ?? 0),
    });
    if (!quoteEstimate.ok) return { parsed: null, problem: quoteEstimate.message };
    const terms = quoteEstimate.value;

    if (side === "buy") {
      if (terms.pkrPaisa > BigInt(balances.pkr_paisa)) {
        return { parsed: null, problem: `You hold ${balances.pkr_display}, and that trade costs PKR ${formatPaisa(terms.pkrPaisa)}.` };
      }
      if (terms.goldMicrograms > BigInt(balances.platform_gold_micrograms)) {
        return {
          parsed: null,
          problem: `The platform holds ${formatMicrograms(BigInt(balances.platform_gold_micrograms))} g, not enough for this buy.`,
        };
      }
    } else {
      if (inputMinor > BigInt(balances.user_gold_micrograms)) {
        return { parsed: null, problem: `You hold ${balances.user_gold_display}, so you cannot sell more than that.` };
      }
    }

    return { parsed: inputMinor, problem: null };
  }, [amount, side, marketPaisaPerGram, balances, settings]);

  // Live preview: exactly the pair of numbers a quote will lock.
  const preview = useMemo(() => {
    if (check.parsed === null || marketPaisaPerGram === null) return null;
    const terms = buildQuote({
      side,
      inputMode: side === "buy" ? "pkr" : "gold",
      inputMinor: check.parsed,
      marketPaisaPerGram,
      guardrailPaisaPerGram: BigInt(settings?.guardrail_paisa_per_gram ?? 0),
    });
    if (!terms.ok) return null;
    return terms.value;
  }, [check, side, marketPaisaPerGram, settings]);

  /* ------------------------------- actions ------------------------------- */

  const submitQuote = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const res = await fetch(`${API}/api/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side, input_mode: side === "buy" ? "pkr" : "gold", input: amount.trim() }),
      });
      const body = await res.json();
      if (res.status === 201 && body.quote) {
        const q = body.quote as QuoteWire;
        setReceipt(null);
        setQuote(q);
        pushToast(
          `${q.side === "buy" ? "Buy" : "Sell"} quote locked at ${q.unit_display} — confirm while the timer runs.`,
          "ok",
        );
      } else {
        const msg = body?.error?.hint
          ? `${body.error.message} ${body.error.hint}`
          : (body?.error?.message ?? "Could not create a quote.");
        pushToast(msg, "error");
      }
    } catch {
      pushToast("Network error — the quote could not be created.", "error");
    } finally {
      creatingRef.current = false;
    }
  };

  const confirmQuote = async () => {
    if (!quote || confirmingRef.current) return;
    confirmingRef.current = true;
    try {
      const res = await fetch(`${API}/api/quotes/${quote.id}/confirm`, { method: "POST" });
      const body = await res.json();
      if (res.status === 200 && body.quote) {
        // Staged confirmation: the quote holds its price as `confirmed` and the
        // trade executes when the timer runs out. The receipt shows up in the
        // polled state right after the expiry sweep settles it.
        pendingQuoteId.current = body.quote.id;
        setQuote(body.quote as QuoteWire);
        pushToast("Trade confirmed — it executes the moment the timer runs out.", "ok");
      } else if (res.status !== 200) {
        // Confirm is idempotent on the server (a replay answers 200), so any
        // non-200 here is a real refusal — expired, cancelled, rejected.
        // The quote card STAYS on screen either way: it folds itself away when
        // its own timer runs out, and the polled state agreements below only
        // stamp the receipt. Erroring away has to never delete the card.
        pushToast(
          body?.error?.hint ? `${body.error.message} ${body.error.hint}` : (body?.error?.message ?? "Could not confirm."),
          "error",
        );
        refetch();
      }
    } catch {
      pushToast("Network error — the quote could not be confirmed.", "error");
    } finally {
      confirmingRef.current = false;
    }
  };

  // The countdown reached zero: fold the quote away locally and refetch — the
  // expiry sweep settles every confirmed quote past its clock, so the settled
  // trade lands in state.trades and the pending effect above stamps the receipt.
  const expireQuote = useCallback(
    (expired: QuoteWire) => {
      setQuote(null);
      refetch();
      if (expired.status === "active") {
        // A confirmed quote expiring executes the trade — its toast comes from
        // the settlement effect below. An unconfirmed active quote just dies.
        pushToast("The quote expired before it was confirmed — nothing was traded.", "warn");
      }
    },
    [refetch, pushToast],
  );

  // A confirmed quote's receipt: the moment the swept settlement shows up,
  // pin it into the receipt display and announce the trade succeeded.
  useEffect(() => {
    if (!state) return;
    const id = pendingQuoteId.current;
    if (!id) return;
    const settledTrade = (state.trades ?? []).find((t) => t.quote_id === id);
    if (settledTrade) {
      pendingQuoteId.current = null;
      setReceipt(settledTrade);
      pushToast(
        `Trade successful: ${settledTrade.side === "buy" ? "bought" : "sold"} ${settledTrade.gold_display} for ${settledTrade.pkr_display}.`,
        "ok",
      );
    }
  }, [state, pushToast]);

  const cancelQuote = async () => {
    if (!quote) return;
    try {
      const res = await fetch(`${API}/api/quotes/${quote.id}/cancel`, { method: "POST" });
      if (res.status !== 200) {
        const body = await res.json();
        pushToast(body?.error?.hint ? `${body.error.message} ${body.error.hint}` : (body?.error?.message ?? "Could not cancel."), "error");
      } else {
        pushToast("Quote cancelled — nothing was traded.", "ok");
      }
      setQuote(null);
    } catch {
      pushToast("Network error — the quote could not be cancelled.", "error");
    }
    refetch();
  };

  // State transitions announce themselves once: trading paused/unpaused by
  // the operator, and the price notice engaging (no reliable price available).
  const forcePaused = settings?.force_paused ?? false;
  const priceNotice = state?.price_notice ?? null;
  const prevPausedRef = useRef<boolean | null>(null);
  const prevNoticeRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevPausedRef.current !== null && forcePaused !== prevPausedRef.current) {
      pushToast(forcePaused ? "Trading is paused." : "Trading resumed.", forcePaused ? "warn" : "ok");
    }
    prevPausedRef.current = forcePaused;
  }, [forcePaused, pushToast]);
  useEffect(() => {
    if (priceNotice && priceNotice !== prevNoticeRef.current) {
      pushToast(priceNotice, "warn");
    }
    prevNoticeRef.current = priceNotice;
  }, [priceNotice, pushToast]);

  /* -------------------------------- render ------------------------------- */

  if (!state) {
    return (
      <div className="stack" style={{ marginTop: 24 }} aria-live="polite" aria-label="Loading">
        <div className="kpi-strip kpi-strip-dark">
          <div className="kpi">
            <span className="skeleton sk-label" />
            <span className="skeleton sk-pill" />
            <span className="skeleton sk-sub" />
          </div>
          <div className="kpi">
            <span className="skeleton sk-label" />
            <span className="skeleton sk-pill" />
            <span className="skeleton sk-sub" />
          </div>
          <div className="kpi">
            <span className="skeleton sk-label" />
            <span className="skeleton sk-pill" />
            <span className="skeleton sk-sub" />
          </div>
        </div>
        <div className="trade-grid">
          <section className="card" style={{ height: 330 }}>
            <div className="sk-pad">
              <span className="skeleton sk-bar" />
              <span className="skeleton sk-field" />
              <span className="skeleton sk-bar" />
            </div>
          </section>
          <section className="card" style={{ height: 220 }}>
            <div className="sk-pad">
              <span className="skeleton sk-label" />
              <span className="skeleton sk-pill" />
            </div>
          </section>
        </div>
      </div>
    );
  }

  const blockedNoPrice = marketPaisaPerGram === null;
  const paused = settings?.force_paused ?? false;
  const canTrade = !blockedNoPrice && !paused;

  return (
    <div className="trade-page">
      {/* handset section titles: mobile-only, ordered into position by CSS;
          on desktop they are inert and the usual card headers carry the page */}
      <p className="mob-sec-title mob-sec-first mob-t-balance">User Balance (PKR and Gold)</p>
      <p className="mob-sec-title mob-t-form">Trade Form</p>
      <p className="mob-sec-title mob-t-history">Trade History</p>

      <BalanceStrip balances={balances} />

      <MobSideChoose side={side} onChange={setSide} />

      <div className="trade-grid">
        <section className="card" aria-label="Trade form">
          <div className="side-tabs" role="tablist" aria-label="Trade side">
            <button
              type="button"
              role="tab"
              aria-selected={side === "buy"}
              className={`side-tab${side === "buy" ? " is-active" : ""}`}
              onClick={() => setSide("buy")}
            >
              Buy
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={side === "sell"}
              className={`side-tab${side === "sell" ? " is-active" : ""}`}
              onClick={() => setSide("sell")}
            >
              Sell
            </button>
          </div>

          {priceNotice ? (
            <p className="notice notice-warn">{priceNotice}</p>
          ) : blockedNoPrice ? (
            <p className="notice notice-warn">
              Prices cannot be validated right now. Please try again in 5 minutes.
            </p>
          ) : null}
          {paused ? <p className="notice notice-warn">Trading is paused in Settings.</p> : null}

          <div className="field-row">
            <div className="field-label-line">
              <label className="field-label" htmlFor="trade-amount">
                {side === "buy" ? "Spend (PKR)" : "Sell (grams)"}
              </label>
              <span className="field-hint">
                {side === "buy" ? "Rs 1,000 – Rs 1,000,000" : "min 0.1 g"}
              </span>
            </div>
            <div className={`amount-input-wrap${check.problem ? " is-error" : ""}`}>
              <input
                id="trade-amount"
                className="amount-input"
                inputMode="decimal"
                placeholder={side === "buy" ? "10,000" : "0.5"}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoComplete="off"
              />
              <span className="amount-unit">{side === "buy" ? "PKR" : "g"}</span>
            </div>
            {check.problem ? <p className="field-error">{check.problem}</p> : null}
            {preview ? (
              <p className="preview-line">
                <span>
                  You would receive
                  <br />
                  at the quote&apos;s locked price
                </span>
                <span className="preview-value">
                  {side === "buy"
                    ? `${formatMicrograms(preview.goldMicrograms)} g`
                    : formatPaisa(preview.pkrPaisa)}
                </span>
              </p>
            ) : null}
          </div>

          <div className="action-row">
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={!amount.trim() || !!check.problem || !!quote || !canTrade}
              onClick={submitQuote}
            >
              {quote ? "Quote in play, resolve it first" : `Get ${side} quote`}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setAmount("");
              }}
            >
              Clear
            </button>
          </div>


          {quote ? (
            <QuoteCard
              quote={quote}
              ttl={settings?.quote_ttl_seconds ?? 75}
              balances={balances}
              onConfirm={confirmQuote}
              onCancel={cancelQuote}
              onExpire={() => expireQuote(quote)}
            />
          ) : null}

          {receipt ? (
            <figcaption className="receipt">
              <div className="receipt-title-line">
                <span className="receipt-stamp" aria-hidden="true" />
                <span className="receipt-amount">
                  {receipt.side === "buy" ? "Bought" : "Sold"} {receipt.gold_display} for{" "}
                  {receipt.pkr_display}
                </span>
              </div>
              <p className="receipt-meta">
                {receipt.unit_display} · market {receipt.market_display} · source {receipt.price_source} ·
                settled {new Date(receipt.settled_at).toLocaleString()}
              </p>
              {receipt.balances_after ? (
                <p className="receipt-meta">
                  Balances: PKR {receipt.balances_before?.pkr_display ?? "—"} → {receipt.balances_after.pkr_display} ·
                  gold {receipt.balances_before?.user_gold_display ?? "—"} → {receipt.balances_after.user_gold_display}
                </p>
              ) : null}
              <p className="receipt-meta">Receipt {receipt.id}</p>
            </figcaption>
          ) : null}
        </section>

        <div className="stack">
          <MarketCard price={price} nowIso={state.now} fetchInterval={settings?.price_fetch_interval_seconds ?? 300} notice={priceNotice} />
        </div>
      </div>

      <ReceiptsSection trades={state?.trades ?? []} />
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((list) => list.filter((t) => t.id !== id))} />
    </div>
  );
}

/* ----------------------------------------------------------------- toasts */

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-stack" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role="status">
          <span className="toast-dot" aria-hidden="true" />
          <span className="toast-text">{t.text}</span>
          <button type="button" className="toast-x" aria-label="Dismiss notification" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Mobile-only Buy/Sell pair (the wireframe places it under the market
 * price card, in the User Balance section). Both this and the desktop
 * tab rail drive the same `side` state; CSS hides one per breakpoint. */
function MobSideChoose({
  side,
  onChange,
}: {
  side: "buy" | "sell";
  onChange: (s: "buy" | "sell") => void;
}) {
  return (
    <div className="mob-side-choose" aria-label="Trade side">
      <button
        type="button"
        className={`mob-side-btn${side === "buy" ? " is-active" : ""}`}
        aria-pressed={side === "buy"}
        onClick={() => onChange("buy")}
      >
        Buy
      </button>
      <button
        type="button"
        className={`mob-side-btn${side === "sell" ? " is-active" : ""}`}
        aria-pressed={side === "sell"}
        onClick={() => onChange("sell")}
      >
        Sell
      </button>
    </div>
  );
}

/* ---------------------------------------------------------- balance strip */

function BalanceStrip({ balances }: { balances: BalancesWire | null }) {
  const totalGold =
    balances
      ? BigInt(balances.user_gold_micrograms) + BigInt(balances.platform_gold_micrograms)
      : null;
  return (
    <div className="kpi-strip kpi-strip-dark" style={{ marginBottom: 24 }}>
      <div className="kpi">
        <p className="kpi-label">PKR wallet</p>
        <p className="kpi-value">{balances?.pkr_display ?? "—"}</p>
        <p className="kpi-sub">your cash</p>
      </div>
      <div className="kpi">
        <p className="kpi-label">Your gold</p>
        <p className="kpi-value">{balances?.user_gold_display ?? "—"}</p>
        <p className="kpi-sub">24K holdings you can sell</p>
      </div>
      <div className="kpi">
        <p className="kpi-label">Platform inventory</p>
        <p className="kpi-value">{balances?.platform_gold_display ?? "—"}</p>
        <p className="kpi-sub">
          {totalGold === null
            ? "—"
            : `total in circulation ${formatMicrograms(totalGold)} g, conserved across every trade`}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- receipts */

function ReceiptsSection({ trades }: { trades: TradeWire[] }) {
  if (trades.length === 0) {
    return (
      <section className="receipts" aria-label="Receipts">
        <div className="receipts-head">
          <h2 className="card-title">Receipts</h2>
          <span className="card-note">every settled trade, newest first</span>
        </div>
        <p className="receipts-empty">No trades yet. Once you confirm a quote, its receipt lands here.</p>
      </section>
    );
  }

  return (
    <section className="receipts" aria-label="Receipts">
      <div className="receipts-head">
        <h2 className="card-title">Receipts</h2>
        <span className="card-note">every settled trade, newest first</span>
      </div>
      <div className="receipts-grid">
        {trades.map((t) => (
          <ReceiptCard key={t.id} trade={t} />
        ))}
      </div>
    </section>
  );
}

function ReceiptCard({ trade }: { trade: TradeWire }) {
  const buy = trade.side === "buy";
  const after = trade.balances_after ?? null;
  const settled = new Date(trade.settled_at).toLocaleString();

  return (
    <article className={`receipt-card${buy ? " is-buy" : " is-sell"}`}>
      <div className="receipt-card-head">
        <span className="receipt-side-pill">{buy ? "Bought" : "Sold"}</span>
        <span className="receipt-when">{settled}</span>
      </div>

      <div className="receipt-card-figures">
        <div className="receipt-figure">
          <p className="receipt-figure-label">Gold</p>
          <p className="receipt-figure-value">
            {buy ? "+" : "−"}{trade.gold_display}
          </p>
        </div>
        <div className="receipt-figure">
          <p className="receipt-figure-label">{buy ? "Charged" : "Paid out"}</p>
          <p className="receipt-figure-value">
            {buy ? "−" : "+"}{trade.pkr_display}
          </p>
        </div>
      </div>

      <div className="receipt-card-rows">
        <div className="receipt-row">
          <span>Price</span>
          <span>{trade.unit_display}</span>
        </div>
        <div className="receipt-row">
          <span>Market</span>
          <span>{trade.market_display}</span>
        </div>
        <div className="receipt-row">
          <span>Source</span>
          <span>{trade.price_source}</span>
        </div>
        {trade.guardrail_applied ? (
          <div className="receipt-row">
            <span>Guardrail</span>
            <span>set the buy price</span>
          </div>
        ) : null}
      </div>

      {after ? (
        <div className="receipt-card-after">
          <span>Balance after</span>
          <span>
            Wallet {after.pkr_display} · gold {after.user_gold_display}
          </span>
        </div>
      ) : null}
    </article>
  );
}

/* ------------------------------------------------------------- quote card */

function QuoteCard({
  quote,
  ttl,
  balances,
  onConfirm,
  onCancel,
  onExpire,
}: {
  quote: QuoteWire;
  ttl: number;
  balances: BalancesWire | null;
  onConfirm: () => void;
  onCancel: () => void;
  onExpire: (q: QuoteWire) => void;
}) {
  const [remainingSeconds, setRemaining] = useState<number | null>(null);
  const expiredAnnounced = useRef(false);
  // Clock-skew calibration: the server stamps expires_at and now on the same
  // clock, so measuring the client's offset once per quote makes the countdown
  // start AT the TTL (not TTL minus however many seconds the two clocks
  // disagree by) and hit 0 exactly when the server itself expires the quote.
  const skewMs = useRef(0);

  useEffect(() => {
    expiredAnnounced.current = false;
    const serverNow = quote.now ? new Date(quote.now).getTime() : null;
    skewMs.current = serverNow === null ? 0 : Date.now() - serverNow;
  }, [quote.id, quote.now]);

  // onExpire is read from a ref so an unstable prop identity cannot repeatedly
  // tear down the timing interval.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    const compute = () => {
      const expires = new Date(quote.expires_at).getTime();
      const left = Math.max(0, Math.round((expires - (Date.now() - skewMs.current)) / 1000));
      setRemaining(left);
      if (left === 0 && !expiredAnnounced.current) {
        expiredAnnounced.current = true;
        onExpireRef.current(quote);
      }
    };
    compute();
    const t = setInterval(compute, 1000);
    return () => clearInterval(t);
  }, [quote.expires_at, quote]);

  const predicted =
    balances && (quote.status === "active" || quote.status === "confirmed")
      ? {
          pkr: BigInt(balances.pkr_paisa) + BigInt(quote.side === "buy" ? -quote.pkr_paisa : quote.pkr_paisa),
          gold:
            BigInt(balances.user_gold_micrograms) +
            BigInt(quote.side === "buy" ? quote.gold_micrograms : -quote.gold_micrograms),
        }
      : null;

  const confirmedQuote = quote.status === "confirmed";

  return (
    <figure className={`quote-card${confirmedQuote ? " is-confirmed" : ""}`} aria-label="Active quote">
      <div className="quote-head">
        <span className="quote-kind">
          {quote.side === "buy" ? "Buy" : "Sell"} {quote.gold_micrograms != null ? formatMicrograms(BigInt(quote.gold_micrograms)) : ""} g
        </span>
        <span
          className={`quote-timer${remainingSeconds !== null && remainingSeconds <= 10 ? " is-low" : ""}`}
          aria-live="polite"
        >
          {remainingSeconds === null ? "" : `${remainingSeconds} s left`}
        </span>
      </div>
      <div className="timer-bar" aria-hidden="true">
        <span
          className="timer-bar-fill"
          style={{ width: `${remainingSeconds === null ? 0 : Math.min(100, (remainingSeconds / ttl) * 100)}%` }}
        />
      </div>
      <div className="quote-row">
        <span className="k">Locked price</span>
        <span className="v">PKR {formatPaisa(BigInt(quote.unit_paisa_per_gram))} / g</span>
      </div>
      <div className="quote-row">
        <span className="k">{quote.side === "buy" ? "Charged" : "Paid out"}</span>
        <span className="v">PKR {formatPaisa(BigInt(quote.pkr_paisa))}</span>
      </div>
      {quote.guardrail_applied ? (
        <div className="quote-row">
          <span className="k">Guardrail</span>
          <span className="v">set the buy price</span>
        </div>
      ) : null}
      <div className="quote-row">
        <span className="k">Source</span>
        <span className="v">{quote.price_source}</span>
      </div>
      {confirmedQuote ? (
        <p className="quote-confirmed-banner">
          Confirmed. The trade executes the moment the timer runs out — cancel kills it before that.
        </p>
      ) : null}
      {predicted ? (
        <p className="quote-predicted">
          After this trade, not yet executed, you would hold <strong>{formatMicrograms(predicted.gold)} g</strong>{" "}
          and <strong>PKR {formatPaisa(predicted.pkr)}</strong>.
        </p>
      ) : null}
      <div className="quote-actions">
        <button
          type="button"
          className="btn btn-primary"
          style={{ flex: 1 }}
          disabled={confirmedQuote}
          onClick={onConfirm}
        >
          {confirmedQuote ? "Confirmed" : "Confirm"}
        </button>
        <button type="button" className="btn btn-danger" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="receipt-meta" style={{ marginTop: 8 }}>
        Confirming holds the price; the trade itself executes when the timer runs out ({ttl}s quote).
        Cancel voids the quote at any time before that, however much time remains. Confirming twice
        still confirms once.
      </p>
    </figure>
  );
}

/* ------------------------------------------------------------ market card */

function MarketCard({
  price,
  nowIso,
  fetchInterval,
  notice,
}: {
  price: PriceWire | null;
  nowIso: string;
  fetchInterval: number;
  notice: string | null;
}) {
  const market = price?.price_paisa_per_gram != null ? BigInt(price.price_paisa_per_gram) : null;
  const buyExact = market !== null ? buyUnitPaisaPerGram(market) : null;
  const sellExact = market !== null ? sellUnitPaisaPerGram(market) : null;

  // One clock, the clock the user cares about: seconds since the price was
  // last updated (a cycle fetched AND stored it). It ticks locally every
  // second, starts at 0 when the fresh price lands, and counts up to the
  // fetch interval until the next cycle resets the clock. The provider's own
  // market stamp ( updatedAt ) is a source-internals detail — from the user's
  // seat "fetched" and "price updated" are the same thing, so only one label
  // is shown. Measured against the server's own now (skew-calibrated) so two
  // clocks disagreeing by a couple of seconds can't show a false 0.
  const fetchedMs = price ? new Date(price.fetched_at).getTime() : null;
  const [baseMs, setBaseMs] = useState(0); // serverNow - fetchedAt at the last calibration
  const calibAtRef = useRef(0); // client Date.now() when baseMs was measured
  const [tickMs, setTickMs] = useState(0);

  useEffect(() => {
    if (fetchedMs === null) return;
    const serverNowMs = nowIso ? new Date(nowIso).getTime() : null;
    if (serverNowMs !== null) {
      setBaseMs(serverNowMs - fetchedMs);
      calibAtRef.current = Date.now();
      setTickMs(0);
    }
  }, [fetchedMs, nowIso]);

  useEffect(() => {
    const t = setInterval(() => setTickMs(Date.now() - calibAtRef.current), 1000);
    return () => clearInterval(t);
  }, []);

  const ageSeconds =
    fetchedMs === null ? null : Math.max(0, Math.floor(Math.max(0, baseMs + tickMs) / 1000));
  // The clock matters for trust: warn as soon as it runs past one interval
  // (the cycle should have refreshed it by now).
  const stale = ageSeconds !== null && ageSeconds > fetchInterval;

  return (
    <section className="card card-market" aria-label="Market price">
      <div className="card-head">
        <h2 className="card-title">Market price · 24K</h2>
        {price?.overridden ? <span className="card-note">override in effect</span> : null}
      </div>
      <div className="price-rows">
        {market !== null ? (
          <>
            <p className="price-figure">
              PKR {formatPaisa(market)}
              <span className="price-unit"> / g</span>
            </p>
            <p className="receipt-meta price-meta-line">
              <span
                className={`status-dot ${stale ? "status-warn" : "status-ok"}`}
                aria-hidden="true"
              />
              <span>
                {price?.source} · {price?.confidence}
                {price?.degraded ? " · degraded" : ""}
              </span>
              <span>{ageSeconds === null ? "" : `price updated ${ageSeconds}s ago`}</span>
            </p>
            {price?.degraded && price.reason ? (
              <p className="receipt-meta" style={{ color: "inherit", fontWeight: 600 }}>
                {price.reason}
              </p>
            ) : null}
          </>
        ) : (
          <p className="price-blocked">{notice ?? "No price: it cannot be validated right now."}</p>
        )}
      </div>
      {market !== null && buyExact !== null && sellExact !== null ? (
        <div className="derived-grid">
          <div className="derived-cell">
            <p className="derived-label">You buy at (10% spread)</p>
            <p className="derived-value">PKR {formatPaisa(buyExact)} / g</p>
          </div>
          <div className="derived-cell">
            <p className="derived-label">You sell at</p>
            <p className="derived-value">PKR {formatPaisa(sellExact)} / g</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
