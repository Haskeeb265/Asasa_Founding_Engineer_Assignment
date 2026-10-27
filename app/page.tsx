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
  active_quote: QuoteWire | null;
  trades: TradeWire[];
  settings: SettingsWire | null;
};

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
  const [actionError, setActionError] = useState<string | null>(null);

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");

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

  // Adopt a quote left active by another tab or a reload — never one whose
  // timer already ran out; the server sweeps those on every /api/state read.
  const serverQuote = state?.active_quote ?? null;
  useEffect(() => {
    if (!serverQuote) return;
    if (new Date(serverQuote.expires_at).getTime() <= Date.now()) return;
    if (!quote) setQuote(serverQuote);
  }, [serverQuote, quote]);

  const settings = state?.settings ?? null;
  const balances = state?.balances ?? null;
  const [showSettings, setShowSettings] = useState(false);
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
    setActionError(null);
    try {
      const res = await fetch(`${API}/api/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side, input_mode: side === "buy" ? "pkr" : "gold", input: amount.trim() }),
      });
      const body = await res.json();
      if (res.status === 201 && body.quote) {
        setReceipt(null);
        setQuote(body.quote as QuoteWire);
      } else {
        setActionError(body?.error?.message ?? "Could not create a quote.");
      }
    } catch {
      setActionError("Network error.");
    }
  };

  const confirmQuote = async () => {
    if (!quote) return;
    setActionError(null);
    try {
      const res = await fetch(`${API}/api/quotes/${quote.id}/confirm`, { method: "POST" });
      const body = await res.json();
      if (res.status === 200 && body.receipt) {
        setReceipt(body.receipt as TradeWire);
        setQuote(null);
      } else {
        setActionError(body?.error?.hint ? `${body.error.message} ${body.error.hint}` : (body?.error?.message ?? "Could not confirm."));
        setQuote(null);
      }
    } catch {
      setActionError("Network error.");
    }
    refetch();
  };

  // The countdown reached zero: fold the quote away locally. The server is the
  // expiry owner (it would refuse a confirm anyway); this only clears the card.
  const expireQuote = useCallback(() => {
    setQuote(null);
    refetch();
  }, [refetch]);

  const cancelQuote = async () => {
    if (!quote) return;
    setActionError(null);
    try {
      const res = await fetch(`${API}/api/quotes/${quote.id}/cancel`, { method: "POST" });
      if (res.status !== 200) {
        const body = await res.json();
        setActionError(body?.error?.message ?? "Could not cancel.");
      }
      setQuote(null);
    } catch {
      setActionError("Network error.");
    }
    refetch();
  };

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
    <>
      <BalanceStrip balances={balances} />

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

          {blockedNoPrice ? (
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
                setActionError(null);
              }}
            >
              Clear
            </button>
          </div>

          {actionError ? <p className="notice notice-warn">{actionError}</p> : null}

          {quote ? (
            <QuoteCard
              quote={quote}
              ttl={settings?.quote_ttl_seconds ?? 75}
              balances={balances}
              onConfirm={confirmQuote}
              onCancel={cancelQuote}
              onExpire={expireQuote}
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
          <MarketCard price={price} />
          <SettingsCard
            settings={settings}
            shown={showSettings}
            onToggle={() => setShowSettings((v) => !v)}
            onRefresh={refetch}
          />
        </div>
      </div>

      <ReceiptsSection trades={state?.trades ?? []} />
    </>
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
        <p className="kpi-value is-primary">{balances?.pkr_display ?? "—"}</p>
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
  onExpire: () => void;
}) {
  const [remainingSeconds, setRemaining] = useState<number | null>(null);
  const expiredAnnounced = useRef(false);

  useEffect(() => {
    expiredAnnounced.current = false;
  }, [quote.id]);

  useEffect(() => {
    const compute = () => {
      const expires = new Date(quote.expires_at).getTime();
      const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0 && !expiredAnnounced.current) {
        expiredAnnounced.current = true;
        onExpire();
      }
    };
    compute();
    const t = setInterval(compute, 1000);
    return () => clearInterval(t);
  }, [quote.expires_at, onExpire]);

  const predicted =
    balances && quote.status === "active"
      ? {
          pkr: BigInt(balances.pkr_paisa) + BigInt(quote.side === "buy" ? -quote.pkr_paisa : quote.pkr_paisa),
          gold:
            BigInt(balances.user_gold_micrograms) +
            BigInt(quote.side === "buy" ? quote.gold_micrograms : -quote.gold_micrograms),
        }
      : null;

  return (
    <figure className="quote-card" aria-label="Active quote">
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
      {predicted ? (
        <p className="quote-predicted">
          After this trade, not yet executed, you would hold <strong>{formatMicrograms(predicted.gold)} g</strong>{" "}
          and <strong>PKR {formatPaisa(predicted.pkr)}</strong>.
        </p>
      ) : null}
      <div className="quote-actions">
        <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={onConfirm}>
          Confirm
        </button>
        <button type="button" className="btn btn-danger" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="receipt-meta" style={{ marginTop: 8 }}>
        The quote folds itself away when the timer runs out; the server refuses confirms past expiry
        regardless ({ttl}s quote). Confirming twice still settles once.
      </p>
    </figure>
  );
}

/* ------------------------------------------------------------ market card */

function MarketCard({ price }: { price: PriceWire | null }) {
  const market = price?.price_paisa_per_gram != null ? BigInt(price.price_paisa_per_gram) : null;
  const buyExact = market !== null ? buyUnitPaisaPerGram(market) : null;
  const sellExact = market !== null ? sellUnitPaisaPerGram(market) : null;
  const age = price?.market_age_seconds;

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
                className={`status-dot ${typeof age === "number" && age > 120 ? "status-warn" : "status-ok"}`}
                aria-hidden="true"
              />
              {price?.source} · {price?.confidence}
              {typeof age === "number" ? ` · fetched ${age}s ago` : ""}
              {price?.degraded ? " · degraded" : ""}
            </p>
            {price?.degraded && price.reason ? (
              <p className="receipt-meta" style={{ color: "rgba(255,255,255,0.92)", fontWeight: 600 }}>
                {price.reason}
              </p>
            ) : null}
          </>
        ) : (
          <p className="price-blocked">No price: it cannot be validated right now.</p>
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

/* ---------------------------------------------------------- settings card */

function SettingsCard({
  settings,
  shown,
  onToggle,
  onRefresh,
}: {
  settings: SettingsWire | null;
  shown: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  const [settingError, setSettingError] = useState<string | null>(null);

  const patch = async (action: string, body: Record<string, unknown>) => {
    setSettingError(null);
    try {
      const res = await fetch(`${API}/api/demo/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status !== 200) {
        const json = await res.json();
        setSettingError(json?.error?.message ?? "Setting failed to save.");
      }
    } catch {
      setSettingError("Network error while saving the setting.");
    }
    onRefresh();
  };

  return (
    <section className="card" aria-label="Settings table controls">
      <div className="card-head">
        <h2 className="card-title">Settings</h2>
        {shown ? (
          <span className="card-note">written to the settings table, live</span>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={shown}
          onClick={onToggle}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>

      {!shown ? (
        <p className="card-note" style={{ padding: "0 16px 14px" }}>
          Hidden. Show it to set the guardrail, pause trading or reset the demo.
        </p>
      ) : null}

      {shown && settingError ? <p className="notice notice-warn">{settingError}</p> : null}

      <div className="settings-list" style={shown ? undefined : { display: "none" }}>
        <Row name="Quote TTL" desc="how long a quote stays confirmable">
          {settings ? (
            <NumberSetting
              value={settings.quote_ttl_seconds}
              min={1}
              max={3600}
              step={5}
              suffix="s"
              inputLabel="Quote TTL"
              onCommit={(v) => patch("ttl", { seconds: v })}
            />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Max price age" desc="staler than this and trading pauses">
          {settings ? (
            <NumberSetting
              value={settings.max_price_age_seconds}
              min={60}
              max={3600}
              step={60}
              suffix="s"
              inputLabel="Max price age"
              onCommit={(v) => patch("max-price-age", { seconds: v })}
            />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Divergence threshold" desc="pairwise source agreement, in bps">
          {settings ? (
            <NumberSetting
              value={settings.divergence_threshold_bps}
              min={1}
              max={5000}
              step={10}
              suffix=" bps"
              inputLabel="Divergence threshold"
              onCommit={(v) => patch("threshold", { bps: v })}
            />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Source C basis" desc="GC=F futures basis, −500..500 bps">
          {settings ? (
            <NumberSetting
              value={settings.source_c_basis_bps}
              min={-500}
              max={500}
              step={1}
              suffix=" bps"
              inputLabel="Source C basis"
              onCommit={(v) => patch("basis", { bps: v })}
            />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Guardrail price floor" desc="0 = off; buys never under it">
          {settings ? (
            <DecimalSetting
              value={settings.guardrail_paisa_per_gram}
              decimals={2}
              zeroIsEmpty={false}
              onCommit={(v) => patch("guardrail", { value: v })}
            />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Price override" desc="verbatim PKR/g that replaces the live price">
          {settings ? (
            <DecimalSetting
              value={settings.price_override_paisa}
              decimals={2}
              zeroIsEmpty
              onCommit={(v) => patch("override", { value: v })}
            />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Trading paused" desc="freezes quoting everywhere">
          {settings ? (
            <Toggle label={settings.force_paused ? "Paused" : "Running"} on={settings.force_paused} onClick={() => patch("pause", { on: !settings.force_paused })} />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Source A · PakGold.pk" desc="primary price source">
          {settings ? (
            <Toggle label={settings.source_a_on ? "On" : "Off"} on={settings.source_a_on} onClick={() => patch("toggle-source", { source: "a", on: !settings.source_a_on })} />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Source B · Goldprice.org" desc="fallback source">
          {settings ? (
            <Toggle label={settings.source_b_on ? "On" : "Off"} on={settings.source_b_on} onClick={() => patch("toggle-source", { source: "b", on: !settings.source_b_on })} />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Source C · Yahoo" desc="validator only, never displayed">
          {settings ? (
            <Toggle label={settings.source_c_on ? "On" : "Off"} on={settings.source_c_on} onClick={() => patch("toggle-source", { source: "c", on: !settings.source_c_on })} />
          ) : (
            "—"
          )}
        </Row>

        <div className="quote-actions" style={{ padding: "10px 0 8px" }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => patch("force-cycle", {})}>
            Force price fetch
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              if (window.confirm("Reset the demo: reseed balances and delete quotes, trades and prices?")) {
                void patch("reset", {});
              }
            }}
          >
            Reset demo
          </button>
        </div>
      </div>
    </section>
  );
}

function Row({ name, desc, children }: { name: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <p className="set-name">{name}</p>
        <p className="set-desc">{desc}</p>
      </div>
      {children}
    </div>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`toggle${on ? " is-on" : ""}`} onClick={onClick} aria-pressed={on}>
      <span className="toggle-dot" aria-hidden="true" />
      {label}
    </button>
  );
}

function NumberSetting({
  value,
  min,
  max,
  step,
  suffix,
  inputLabel,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  inputLabel: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const shown = useMemo(() => {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }, [value]);
  useEffect(() => setDraft(String(shown)), [shown]);
  const clamped = Math.min(max, Math.max(min, shown));

  const commit = (v: number) => {
    const next = Math.min(max, Math.max(min, Math.round(v / step) * step || v));
    if (next !== shown) onCommit(next);
  };

  return (
    <span className="stepper">
      <button type="button" className="stepper-btn" disabled={clamped - step < min} onClick={() => commit(shown - step)} aria-label={`decrease by ${step}`}>
        −
      </button>
      <input
        className="stepper-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (Number.isFinite(n)) commit(n);
          else setDraft(String(shown));
        }}
        inputMode="numeric"
        aria-label={`${inputLabel} value`}
      />
      <button type="button" className="stepper-btn" disabled={clamped + step > max} onClick={() => commit(shown + step)} aria-label={`increase by ${step}`}>
        +
      </button>
      <span className="set-value">{suffix}</span>
    </span>
  );
}

function DecimalSetting({
  value,
  decimals,
  zeroIsEmpty,
  onCommit,
}: {
  value: number | null;
  decimals: number;
  zeroIsEmpty: boolean;
  onCommit: (v: string | null) => void;
}) {
  const shown = (n: number | null): string =>
    n === null || (zeroIsEmpty && n === 0) ? "" : (n / 100).toFixed(decimals);
  const [draft, setDraft] = useState(shown(value));
  useEffect(() => setDraft(shown(value)), [value, decimals, zeroIsEmpty]);

  return (
    <span className="stepper">
      <input
        className="mini-input"
        value={draft}
        inputMode="decimal"
        placeholder={zeroIsEmpty ? "off" : "0.00"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const text = draft.trim();
          if (text === "") {
            if (zeroIsEmpty) {
              onCommit(null);
            } else {
              onCommit("0");
            }
            setDraft("");
            return;
          }
          const n = Number(text.replace(/,/g, ""));
          if (Number.isFinite(n) && n >= 0) {
            onCommit(text);
            setDraft((n / 100).toFixed(decimals));
          } else {
            setDraft(shown(value));
          }
        }}
        aria-label="value input"
      />
      <span className="set-value">PKR/g</span>
    </span>
  );
}
