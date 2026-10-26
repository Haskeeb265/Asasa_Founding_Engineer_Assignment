"use client";

import { useState, useEffect } from "react";

const DEPLOY_BASE =
  process.env.NEXT_PUBLIC_DEPLOY_BASE ??
  "https://asasaassignment-mmikzniu5-haskeeb265s-projects.vercel.app";

type State = {
  balances:
    | {
        pkr_display: string;
        user_gold_display: string;
        platform_gold_display: string;
        pkr_paisa: number;
        user_gold_micrograms: number;
        platform_gold_micrograms: number;
      }
    | null;
  price:
    | {
        price_display: string;
        source: string;
        confidence: string;
        market_age_seconds: number | null;
        reason: string | null;
        degraded: boolean;
        overridden: boolean;
      }
    | null;
  active_quote:
    | {
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
      }
    | null;
  trades: Array<{
    id: string;
    side: string;
    gold_display: string;
    pkr_display: string;
    unit_display: string;
    market_display: string;
    price_source: string;
    settled_at: string;
    quote_created_at: string;
  }>;
  settings:
    | {
        quote_ttl_seconds: number;
        force_paused: boolean;
        guardrail_paisa_per_gram: number;
        price_override_paisa: number | null;
      }
    | null;
  error: string | null;
} | null;

type TradeResult =
  | { quote?: { id: string } }
  | { error?: { code: string; message: string; hint?: string } };
type ReceiptResult =
  | {
      receipt?: {
        id: string;
        quote_id: string;
        side: string;
        gold_display: string;
        pkr_display: string;
        unit_display: string;
        market_display: string;
        price_source: string;
        settled_at: string;
        quote_created_at: string;
      };
    }
  | { error?: { code: string; message: string } };

export default function Page() {
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 18, boxSizing: "border-box" }}>
      <Tabs />
    </div>
  );
}

function Tabs() {
  const [activeTab, setActiveTab] = useState<"trade" | "data">("trade");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid #D9D7D2",
          paddingBottom: 0,
        }}
      >
        <TabButton
          label="Trade"
          active={activeTab === "trade"}
          onClick={() => setActiveTab("trade")}
        />
        <TabButton
          label="Live data"
          active={activeTab === "data"}
          onClick={() => setActiveTab("data")}
        />
      </div>

      {activeTab === "trade" ? (
        <TradePage />
      ) : (
        <LiveDataTable />
      )}
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "8px 16px",
        background: active ? "#0D4A46" : "transparent",
        color: active ? "#FFFFFF" : "#5B5F5A",
        border: "none",
        borderRadius: "6px 6px 0 0",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        letterSpacing: 0.02,
        marginBottom: -1,
      }}
    >
      {label}
    </button>
  );
}

function TradePage() {
  const [pState, setPState] = useState<State | null>(null);
  const state = pState ?? {
    balances: null,
    price: null,
    active_quote: null,
    trades: [],
    settings: null,
    error: null,
  };
  const setState = setPState;

  const [tradeResult, setTradeResult] = useState<TradeResult | null>(null);
  const [receipt, setReceipt] = useState<ReceiptResult | null>(null);
  const [chosenSide, setChosenSide] = useState("buy");
  const [chosenMode, setChosenMode] = useState("pkr");
  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState("");

  useEffect(() => {
    fetch(`${DEPLOY_BASE}/api/state`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!json) {
          setState((prev) =>
            prev
              ? { ...prev, error: "Could not reach the app." }
              : null
          );
          return;
        }
        if (json.error) {
          setState((prev) =>
            prev ? { ...prev, error: json.error.message } : null
          );
          return;
        }
        setState(json as State);
      })
      .catch(() =>
        setState((prev) =>
          prev
            ? { ...prev, error: "Could not reach the app." }
            : null
        )
      );
  }, []);

  const submitQuote = () => {
    if (!state) return;
    setTradeResult(null);
    setAmountError("");
    const body = { side: chosenSide, input_mode: chosenMode, input: amount };
    fetch(`${DEPLOY_BASE}/api/quotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json().then((body) => ({ status: r.status, body })))
      .then((res) => {
        const { status, body } = res;
        if (status === 201 && body?.quote) {
          setTradeResult({ quote: { id: body.quote.id } });
        } else {
          const err =
            body?.error ?? { code: "UNKNOWN", message: "Could not create a quote." };
          setTradeResult({ error: err });
          if (err?.hint) setAmountError(err.hint);
        }
      })
      .catch(() =>
        setTradeResult({ error: { code: "UNKNOWN", message: "Network error." } })
      );
  };

  const confirmQuote = (quoteId: string) => {
    if (!state) return;
    setReceipt(null);
    fetch(`${DEPLOY_BASE}/api/quotes/${quoteId}/confirm`, { method: "POST" })
      .then((r) => r.json().then((body) => ({ status: r.status, body })))
      .then((res) => {
        const { status, body } = res;
        if (status === 200 && body?.receipt) {
          setReceipt({ receipt: body.receipt });
        } else {
          setReceipt({
            error:
              body?.error ?? { code: "UNKNOWN", message: "Could not settle the trade." },
          });
        }
      })
      .catch(() =>
        setReceipt({ error: { code: "UNKNOWN", message: "Network error." } })
      );
  };

  const cancelQuote = (quoteId: string) => {
    if (!state) return;
    setReceipt(null);
    fetch(`${DEPLOY_BASE}/api/quotes/${quoteId}/cancel`, { method: "POST" })
      .then((r) => r.json().then((body) => ({ status: r.status, body })))
      .then((res) => {
        const { status, body } = res;
        if (status !== 200) {
          setReceipt({
            error:
              body?.error ?? { code: "UNKNOWN", message: "Could not cancel the quote." },
          });
        }
      })
      .catch(() =>
        setReceipt({ error: { code: "UNKNOWN", message: "Network error." } })
      );
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) 340px",
        gap: 18,
        padding: 18,
        maxWidth: 1180,
        margin: "0 auto",
        boxSizing: "border-box",
      }}
    >
      <div>
        <TradeFlowInner
          stateLike={state}
          chosenSide={chosenSide}
          setChosenSide={setChosenSide}
          chosenMode={chosenMode}
          setChosenMode={setChosenMode}
          amount={amount}
          setAmount={setAmount}
          amountError={amountError}
          setAmountError={setAmountError}
          tradeResult={tradeResult}
          setTradeResult={setTradeResult}
          submitQuote={submitQuote}
          receipt={receipt}
          setReceipt={setReceipt}
          confirmQuote={confirmQuote}
          cancelQuote={cancelQuote}
        />
      </div>
      <aside style={{ alignSelf: "start" }}>
        <StatePanel stateLike={state} confirmQuote={confirmQuote} cancelQuote={cancelQuote} />
      </aside>
    </div>
  );
}

function TradeFlowInner({
  stateLike,
  chosenSide,
  setChosenSide,
  chosenMode,
  setChosenMode,
  amount,
  setAmount,
  amountError,
  setAmountError,
  tradeResult,
  setTradeResult,
  submitQuote,
  receipt,
  setReceipt,
  confirmQuote,
  cancelQuote,
}: {
  stateLike: State | null;
  chosenSide: string;
  setChosenSide: (v: string) => void;
  chosenMode: string;
  setChosenMode: (v: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  amountError: string;
  setAmountError: (v: string) => void;
  tradeResult: TradeResult | null;
  setTradeResult: (v: TradeResult | null) => void;
  submitQuote: () => void;
  receipt: ReceiptResult | null;
  setReceipt: (v: ReceiptResult | null) => void;
  confirmQuote: (id: string) => void;
  cancelQuote: (id: string) => void;
}) {
  const state = stateLike ?? {
    balances: null,
    price: null,
    active_quote: null,
    trades: [],
    settings: null,
    error: null,
  };
  if (!stateLike) {
    return (
      <main style={{ paddingTop: 4 }}>
        <h1
          style={{
            fontSize: 20,
            margin: "0 0 4px",
            color: "#0D4A46",
            fontWeight: 700,
            letterSpacing: "-0.01em",
          }}
        >
          Loading…
        </h1>
      </main>
    );
  }

  const paused = state.settings?.force_paused;
  const hasQuote = !!(tradeResult && "quote" in tradeResult);
  const hasReceipt = !!(receipt && "receipt" in receipt);
  const activeQuote = state.active_quote ?? null;

  return (
    <main style={{ paddingTop: 4 }}>
      <h1
        style={{
          fontSize: 20,
          margin: "0 0 4px",
          color: "#0D4A46",
          fontWeight: 700,
          letterSpacing: "-0.01em",
        }}
      >
        Buy / sell gold
      </h1>
      <p style={{ margin: "0 0 16px", color: "#5B5F5A", fontSize: 14 }}>
        Enter an amount, pick a side, then get a 75-second quote, then confirm once.
      </p>

      {paused ? (
        <p
          style={{
            margin: "0 0 16px",
            color: "#B3261E",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Trading is paused. Use the demo panel to resume, or the live-data table to
          see why.
        </p>
      ) : null}

      <section
        aria-label="Trade form"
        style={{
          border: "1px solid #D9D7D2",
          borderRadius: 10,
          background: "#FFFFFF",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        <Field label="Side">
          <div style={{ display: "flex", gap: 8 }}>
            <SegmentedControl
              label="Buy"
              value="buy"
              checked={chosenSide === "buy"}
              onClick={() => setChosenSide("buy")}
            />
            <SegmentedControl
              label="Sell"
              value="sell"
              checked={chosenSide === "sell"}
              onClick={() => setChosenSide("sell")}
            />
          </div>
        </Field>

        <Field label="I want to…">
          <div style={{ display: "flex", gap: 8 }}>
            <SegmentedControl
              label="Spend PKR"
              value="pkr"
              checked={chosenMode === "pkr"}
              onClick={() => setChosenMode("pkr")}
            />
            <SegmentedControl
              label="Trade grams"
              value="gold"
              checked={chosenMode === "gold"}
              onClick={() => setChosenMode("gold")}
            />
          </div>
        </Field>

        <Field label="Amount" error={amountError}>
          <input
            type="text"
            inputMode="decimal"
            pattern="[0-9,]*"
            placeholder={chosenMode === "pkr" ? "e.g. 10000" : "e.g. 1"}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{
              width: "100%",
              padding: "9px 10px",
              fontSize: 15,
              border: amountError ? "1px solid #B3261E" : "1px solid #D9D7D2",
              borderRadius: 6,
              background: "#F9FAFA",
              color: "#1A1F1B",
              fontVariantNumeric: "tabular-nums",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </Field>

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            disabled={!amount.trim() || !!amountError || hasQuote || hasReceipt}
            onClick={submitQuote}
            style={{
              flex: 1,
              background: "#0D4A46",
              color: "#FFFFFF",
              border: "none",
              borderRadius: 6,
              padding: "9px 12px",
              fontSize: 14,
              fontWeight: 600,
              cursor:
                !amount || !!amountError || hasQuote || hasReceipt
                  ? "not-allowed"
                  : "pointer",
              letterSpacing: 0.02,
            }}
          >
            {hasQuote ? "Quote ready" : "Get quote"}
          </button>
          <button
            type="button"
            disabled={!amount.trim() && !amountError}
            onClick={() => {
              setAmount("");
              setAmountError("");
              setTradeResult(null);
              setReceipt(null);
            }}
            style={{
              background: "transparent",
              color: "#0D4A46",
              border: "1px solid #0D4A46",
              borderRadius: 6,
              padding: "9px 12px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      </section>

      {tradeResult && "error" in tradeResult && tradeResult.error && (
        <p style={{ marginTop: 12, color: "#B3261E", fontSize: 13 }}>
          {tradeResult.error.message}
          {tradeResult.error.hint ? ` (${tradeResult.error.hint})` : ""}
        </p>
      )}

      {activeQuote && !hasQuote && (
        <p style={{ marginTop: 12, color: "#3A3F39", fontSize: 13 }}>
          Quote ready for {activeQuote.side === "buy" ? "buying" : "selling"}{" "}
          {formatMicro(activeQuote.gold_micrograms)} g. Choose confirm to settle, or cancel to discard.
        </p>
      )}

      {receipt && "receipt" in receipt && receipt.receipt && (
        <section
          aria-label="Trade receipt"
          style={{
            marginTop: 16,
            border: "1px solid #D9D7D2",
            borderRadius: 10,
            background: "#FFFFFF",
            padding: 16,
            boxSizing: "border-box",
          }}
        >
          <h2
            style={{
              margin: "0 0 8px",
              fontSize: 14,
              color: "#0D4A46",
              fontWeight: 600,
            }}
          >
            Receipt
          </h2>
          <p style={{ margin: "0 0 4px", color: "#3A3F39" }}>
            {receipt.receipt.side === "buy" ? "Bought" : "Sold"}{" "}
            {receipt.receipt.gold_display} for {receipt.receipt.pkr_display}.
          </p>
          <p style={{ margin: "0 0 4px", color: "#6B706B", fontSize: 12 }}>
            Unit: {receipt.receipt.unit_display} · market:{" "}
            {receipt.receipt.market_display} · source:{" "}
            {receipt.receipt.price_source}
          </p>
          <p style={{ margin: "0 0 4px", color: "#6B706B", fontSize: 12 }}>
            Settled at{" "}
            {new Date(receipt.receipt.settled_at).toLocaleString()} · quote created{" "}
            {new Date(receipt.receipt.quote_created_at).toLocaleString()}
          </p>
          <p style={{ margin: "0", color: "#6B706B", fontSize: 12 }}>
            Trade id: {receipt.receipt.id} · quote: {receipt.receipt.quote_id}
          </p>
        </section>
      )}

      {receipt && "error" in receipt && receipt.error && (
        <p style={{ marginTop: 12, color: "#B3261E", fontSize: 13 }}>
          {receipt.error.message}
        </p>
      )}

      <p style={{ marginTop: 14, fontSize: 12, color: "#8A8F8A" }}>
        Prices are locked for 75 seconds once a quote is created. Confirming twice
        returns the same receipt.
      </p>
    </main>
  );
}

function Field({
  label,
  children,
  error,
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 0.04,
          textTransform: "uppercase",
          color: "#5B5F5A",
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {children}
      {error ? (
        <p style={{ margin: "4px 0 0", color: "#B3261E", fontSize: 12 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SegmentedControl({
  label,
  value,
  checked,
  onClick,
}: {
  label: string;
  value: string;
  checked: boolean;
  onClick: () => void;
}) {
  const border = checked ? "none" : "1px solid #D9D7D2";
  const bg = checked ? "#0D4A46" : "#FFFFFF";
  const fg = checked ? "#FFFFFF" : "#1A1F1B";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        background: bg,
        color: fg,
        border,
        borderRadius: 6,
        padding: "7px 10px",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        textAlign: "center",
        letterSpacing: 0.02,
        boxSizing: "border-box",
      }}
    >
      {label}
    </button>
  );
}

function StatePanel({ stateLike, confirmQuote, cancelQuote }: { stateLike: State | null; confirmQuote: (id: string) => void; cancelQuote: (id: string) => void }) {
  const stateInner = stateLike ?? {
    balances: null,
    price: null,
    active_quote: null,
    trades: [],
    settings: null,
    error: null,
  };

  if (!stateLike) {
    return (
      <section
        aria-label="Demo state panel"
        style={{
          border: "1px solid #D9D7D2",
          borderRadius: 10,
          background: "#FFFFFF",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        <h2
          style={{
            fontSize: 13,
            letterSpacing: 0.06,
            textTransform: "uppercase",
            color: "#5B5F5A",
            margin: "0 0 12px",
            fontWeight: 600,
          }}
        >
          Your balances
        </h2>
        <p style={{ fontSize: 12, color: "#8A8F8A" }}>
          Loading state from the database…
        </p>
      </section>
    );
  }
  return (
    <section
      aria-label="Demo state panel"
      style={{
        border: "1px solid #D9D7D2",
        borderRadius: 10,
        background: "#FFFFFF",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      <h2
        style={{
          fontSize: 13,
          letterSpacing: 0.06,
          textTransform: "uppercase",
          color: "#5B5F5A",
          margin: "0 0 12px",
          fontWeight: 600,
        }}
      >
        Your balances
      </h2>
      <BalanceCard
        label="PKR wallet"
        value={stateInner.balances?.pkr_display ?? ""}
      />
      <BalanceCard
        label="Your gold"
        value={stateInner.balances?.user_gold_display ?? ""}
      />
      <BalanceCard
        label="Platform inventory"
        value={stateInner.balances?.platform_gold_display ?? ""}
      />

      <hr style={{ border: "none", borderTop: "1px solid #E7E4DF", margin: "14px 0" }} />

      <PriceCard price={stateInner.price} />

      <hr style={{ border: "none", borderTop: "1px solid #E7E4DF", margin: "14px 0" }} />

      <QuoteCard
        activeQuote={stateInner.active_quote}
        settings={stateInner.settings}
        confirmQuote={confirmQuote}
        cancelQuote={cancelQuote}
      />
    </section>
  );
}

function BalanceCard({ label, value }: { label: string; value: string }) {
  return (
    <p
      style={{
        margin: "6px 0",
        fontSize: 13,
        color: "#3A3F39",
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        minHeight: 22,
      }}
    >
      <span style={{ color: "#6B706B" }}>{label}</span>
      <span
        style={{
          fontVariantNumeric: "tabular-nums",
          fontWeight: 600,
          textAlign: "right",
        }}
      >
        {value || "—"}
      </span>
    </p>
  );
}

function PriceCard({
  price,
}: {
  price: NonNullable<State>["price"] | null;
}) {
  const display = price?.price_display ?? "—";
  const source = price?.source ?? "—";
  const confidence = price?.confidence ?? "—";
  const age =
    price?.market_age_seconds == null ? "—" : `${price.market_age_seconds} s`;
  const reason = price?.reason;
  const notes = [
    confidence,
    price?.degraded ? "degraded" : "",
    price?.overridden ? "overridden" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div style={{ fontSize: 13 }}>
      <p style={{ margin: "0 0 4px", color: "#6B706B", fontWeight: 500 }}>
        Market price
      </p>
      <p
        style={{
          margin: "0 0 6px",
          fontVariantNumeric: "tabular-nums",
          fontSize: 15,
          color: price ? "#0D4A46" : "#9A9F9A",
          fontWeight: 600,
        }}
      >
        {display}
      </p>
      <p style={{ margin: "0 0 2px", color: "#6B706B", fontSize: 12 }}>
        Source: {source} · {notes}
      </p>
      <p style={{ margin: "0", color: "#6B706B", fontSize: 12 }}>Age: {age}</p>
      {reason ? (
        <p style={{ margin: "6px 0 0", color: "#B3261E", fontSize: 12 }}>
          {reason}
        </p>
      ) : null}
    </div>
  );
}

function QuoteCard({
  activeQuote,
  settings,
  confirmQuote,
  cancelQuote,
}: {
  activeQuote: NonNullable<State>["active_quote"] | null;
  settings: NonNullable<State>["settings"] | null;
  confirmQuote: (id: string) => void;
  cancelQuote: (id: string) => void;
}) {
  if (!activeQuote) {
    return (
      <div
        style={{
          fontSize: 13,
          background: "#F3F6F5",
          borderRadius: 8,
          padding: "10px 12px",
          border: "1px solid #D9D7D2",
        }}
      >
        <p style={{ margin: "0 0 8px", color: "#6B706B", fontWeight: 500 }}>
          Active quote
        </p>
        <p style={{ margin: "0 0 6px", color: "#3A3F39" }}>No active quote.</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>        <QuoteAction
          label="Refresh state"
          intent="ghost"
          onClick={() => {}}
        />
        </div>
      </div>
    );
  }

  const ttl = settings?.quote_ttl_seconds ?? 75;
  const created = new Date(activeQuote.created_at);
  const elapsed = Math.max(0, Math.floor((Date.now() - created.getTime()) / 1000));
  const remaining = Math.max(0, ttl - elapsed);
  const paused = settings?.force_paused;

  return (
    <div
      style={{
        fontSize: 13,
        background: "#F3F6F5",
        borderRadius: 8,
        padding: "10px 12px",
        border: "1px solid #D9D7D2",
      }}
    >
      <p style={{ margin: "0 0 8px", color: "#6B706B", fontWeight: 500 }}>
        Active quote
      </p>
      <p style={{ margin: "0 0 2px", color: "#3A3F39", fontWeight: 600 }}>
        {activeQuote.side === "buy" ? "Buy" : "Sell"} ·{" "}
        {activeQuote.input_mode === "pkr" ? "PKR" : "grams"}
      </p>
      <p style={{ margin: "0 0 2px", color: "#3A3F39" }}>
        ${formatMicro(activeQuote.gold_micrograms)} g for
        PKR ${activeQuote.pkr_paisa.toLocaleString()}
      </p>
      <p style={{ margin: "0 0 2px", color: "#6B706B", fontSize: 12 }}>
        Unit:{" "}
        PKR ${activeQuote.unit_paisa_per_gram.toLocaleString()}/g
      </p>
      <p style={{ margin: "0 0 2px", color: "#6B706B", fontSize: 12 }}>
        Locked {ttl}s · {remaining}s remaining
      </p>
      {paused ? (
        <p style={{ margin: "0 0 6px", color: "#B3261E", fontSize: 12 }}>
          Trading is paused — confirm will be rejected.
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <QuoteAction
          label="Refresh state"
          intent="ghost"
          onClick={() => {}}
        />
        <QuoteAction
          label="Confirm"
          intent="primary"
          onClick={() => confirmQuote(activeQuote.id)}
        />
        <QuoteAction
          label="Cancel"
          intent="danger"
          onClick={() => cancelQuote(activeQuote.id)}
        />
      </div>
    </div>
  );
}

function QuoteAction({
  label,
  intent,
  onClick,
}: {
  label: string;
  intent: "primary" | "danger" | "ghost";
  onClick: () => void;
}) {
  const bg =
    intent === "primary"
      ? "#0D4A46"
      : intent === "danger"
        ? "#B3261E"
        : "transparent";
  const fg = intent === "ghost" ? "#0D4A46" : "#FFFFFF";
  const border = intent === "ghost" ? "1px solid #0D4A46" : "none";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: bg,
        color: fg,
        border,
        borderRadius: 6,
        padding: "5px 10px",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        letterSpacing: 0.02,
      }}
    >
      {label}
    </button>
  );
}

function LiveDataTable() {
  const [data, setData] = useState<{
    balances: {
      pkr_paisa: number;
      user_gold_micrograms: number;
      platform_gold_micrograms: number;
      pkr_display: string;
      user_gold_display: string;
      platform_gold_display: string;
    } | null;
    price: {
      price_display: string;
      source: string;
      confidence: string;
      market_age_seconds: number | null;
      reason: string | null;
      degraded: boolean;
      overridden: boolean;
      price_paisa_per_gram: number;
      price_micrograms_per_gram: number;
    } | null;
    active_quote: {
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
    } | null;
    trades: Array<{
      id: string;
      side: string;
      gold_display: string;
      pkr_display: string;
      unit_display: string;
      market_display: string;
      price_source: string;
      settled_at: string;
      quote_created_at: string;
    }>;
    settings: {
      quote_ttl_seconds: number;
      force_paused: boolean;
      guardrail_paisa_per_gram: number;
      price_override_paisa: number | null;
      source_a_on: boolean;
      source_b_on: boolean;
      source_c_on: boolean;
      divergence_threshold_bps: number;
      max_price_age_seconds: number;
      source_c_basis_bps: number;
    } | null;
    now: string;
  } | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      fetch(`${DEPLOY_BASE}/api/state`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          if (json && !json.error) {
            setData(json as any);
          }
        })
        .catch(() => {});
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  if (!data) {
    return (
      <div
        style={{
          border: "1px solid #D9D7D2",
          borderRadius: 10,
          background: "#FFFFFF",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        <h2
          style={{
            fontSize: 14,
            margin: "0 0 12px",
            color: "#0D4A46",
            fontWeight: 600,
          }}
        >
          Live database state
        </h2>
        <p style={{ color: "#8A8F8A", fontSize: 13 }}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          border: "1px solid #D9D7D2",
          borderRadius: 10,
          background: "#FFFFFF",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        <h2
          style={{
            fontSize: 14,
            margin: "0 0 12px",
            color: "#0D4A46",
            fontWeight: 600,
          }}
        >
          Balances
        </h2>
        <DataTable
          headers={[
            { label: "PKR wallet (paisa)", key: "pkr_paisa" },
            { label: " PKR wallet", key: "pkr_display" },
            { label: "Your gold (µg)", key: "user_gold_micrograms" },
            { label: " Your gold", key: "user_gold_display" },
            { label: "Platform inventory (µg)", key: "platform_gold_micrograms" },
            { label: " Platform", key: "platform_gold_display" },
          ]}
          row={data.balances ?? {}}
        />
      </div>

      <div
        style={{
          border: "1px solid #D9D7D2",
          borderRadius: 10,
          background: "#FFFFFF",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        <h2
          style={{
            fontSize: 14,
            margin: "0 0 12px",
            color: "#0D4A46",
            fontWeight: 600,
          }}
        >
          Market price
        </h2>
        <DataTable
          headers={[
            { label: "Display", key: "price_display" },
            { label: "Source", key: "source" },
            { label: "Confidence", key: "confidence" },
            { label: "Age (s)", key: "market_age_seconds" },
            { label: "PKR/g (paisa)", key: "price_paisa_per_gram" },
            { label: "g/µg", key: "price_micrograms_per_gram" },
            { label: "Degraded", key: "degraded" },
            { label: "Overridden", key: "overridden" },
            { label: "Reason", key: "reason" },
          ]}
          row={data.price ?? {}}
        />
      </div>

      <div
        style={{
          border: "1px solid #D9D7D2",
          borderRadius: 10,
          background: "#FFFFFF",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        <h2
          style={{
            fontSize: 14,
            margin: "0 0 12px",
            color: "#0D4A46",
            fontWeight: 600,
          }}
        >
          Active quote
        </h2>
        {data.active_quote ? (
          <DataTable
            headers={[
              { label: "ID", key: "id" },
              { label: "Side", key: "side" },
              { label: "Status", key: "status" },
              { label: "Input mode", key: "input_mode" },
              { label: "Input (minor)", key: "input_minor" },
              { label: "Market (PKR/g)", key: "market_paisa_per_gram" },
              { label: "Unit (PKR/g)", key: "unit_paisa_per_gram" },
              { label: "Spread (bps)", key: "spread_bps" },
              { label: "Gold (µg)", key: "gold_micrograms" },
              { label: "PKR (paisa)", key: "pkr_paisa" },
              { label: "Guardrail applied", key: "guardrail_applied" },
              { label: "Price source", key: "price_source" },
              { label: "Price fetched at", key: "price_fetched_at" },
              { label: "Expires at", key: "expires_at" },
              { label: "Created at", key: "created_at" },
            ]}
            row={data.active_quote}
          />
        ) : (
          <p style={{ color: "#8A8F8A", fontSize: 13 }}>No active quote.</p>
        )}
      </div>

      <div
        style={{
          border: "1px solid #D9D7D2",
          borderRadius: 10,
          background: "#FFFFFF",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        <h2
          style={{
            fontSize: 14,
            margin: "0 0 12px",
            color: "#0D4A46",
            fontWeight: 600,
          }}
        >
          Recent trades
        </h2>
        {data.trades.length > 0 ? (
          <DataTable
            headers={[
              { label: "ID", key: "id" },
              { label: "Side", key: "side" },
              { label: "Gold", key: "gold_display" },
              { label: "PKR", key: "pkr_display" },
              { label: "Unit", key: "unit_display" },
              { label: "Market", key: "market_display" },
              { label: "Source", key: "price_source" },
              { label: "Settled at", key: "settled_at" },
              { label: "Quote created", key: "quote_created_at" },
            ]}
            rows={data.trades}
          />
        ) : (
          <p style={{ color: "#8A8F8A", fontSize: 13 }}>No trades yet.</p>
        )}
      </div>

      <div
        style={{
          border: "1px solid #D9D7D2",
          borderRadius: 10,
          background: "#FFFFFF",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        <h2
          style={{
            fontSize: 14,
            margin: "0 0 12px",
            color: "#0D4A46",
            fontWeight: 600,
          }}
        >
          Settings
        </h2>
        <DataTable
          headers={[
            { label: "Quote TTL (s)", key: "quote_ttl_seconds" },
            { label: "Force paused", key: "force_paused" },
            { label: "Guardrail (PKR/g)", key: "guardrail_paisa_per_gram" },
            { label: "Price override (PKR/g)", key: "price_override_paisa" },
            { label: "Source A on", key: "source_a_on" },
            { label: "Source B on", key: "source_b_on" },
            { label: "Source C on", key: "source_c_on" },
            { label: "Divergence threshold (bps)", key: "divergence_threshold_bps" },
            { label: "Max price age (s)", key: "max_price_age_seconds" },
            { label: "Source C basis (bps)", key: "source_c_basis_bps" },
          ]}
          row={data.settings ?? {}}
        />
      </div>

      <p style={{ color: "#8A8F8A", fontSize: 12 }}>
        Auto-refreshes every 2 seconds. For evaluation purposes only.
      </p>
    </div>
  );
}

function DataTable({
  headers,
  row,
  rows,
}: {
  headers: Array<{ label: string; key: string }>;
  row?: Record<string, any>;
  rows?: Array<Record<string, any>>;
}) {
  const displayRows = rows ?? [row];

  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 12,
      }}
    >
      <thead>
        <tr
          style={{
            background: "#F3F6F5",
            borderBottom: "1px solid #D9D7D2",
          }}
        >
          {headers.map((h) => (
            <th
              key={h.key}
              style={{
                textAlign: "left",
                padding: "6px 8px",
                color: "#5B5F5A",
                fontWeight: 600,
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.04,
                whiteSpace: "nowrap",
              }}
            >
              {h.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {displayRows.map((r, i) => (
          <tr
            key={i}
            style={{ borderBottom: "1px solid #E7E4DF" }}
          >
            {headers.map((h) => (
              <td
                key={h.key}
                style={{
                  padding: "6px 8px",
                  color: "#3A3F39",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                {formatValue(r?.[h.key]) ?? "—"}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatValue(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") {
    if (v instanceof Date) return v.toLocaleString();
    return JSON.stringify(v);
  }
  return String(v);
}

const formatMicro = (v: number) => (v / 1_000_000).toFixed(6);
