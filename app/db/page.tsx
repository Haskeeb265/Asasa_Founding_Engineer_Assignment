"use client";

/**
 * Live database page: a quiet mirror of every table's latest rows,
 * polled every 2 seconds. Answers "what is in the database right now?"
 * in reading order: the ledger, the settings row, quotes, trades, price rows.
 */

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "../chrome";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

type BalanceRow = {
  key: string;
  unit: string;
  amount_minor: number;
  display: string;
  updated_at: string | null;
};

type SettingsRow = {
  guardrail_pkr_per_gram: number;
  quote_ttl_seconds: number;
  divergence_threshold_bps: number;
  max_price_age_seconds: number;
  price_fetch_interval_seconds: number;
  source_a_on: boolean;
  source_b_on: boolean;
  source_c_on: boolean;
  source_c_basis_bps: number;
  price_override_pkr_per_gram: number | null;
  force_paused: boolean;
  updated_at: string | null;
};

type QuoteRow = {
  id: string;
  idempotency_key: string;
  side: string;
  status: string;
  input_mode: string;
  input_display: string;
  market_display: string;
  execution_display: string;
  gold_display: string;
  pkr_display: string;
  guardrail_applied: boolean;
  price_source: string;
  rejection_reason: string | null;
  created_at: string | null;
  expires_at: string | null;
  settled_at: string | null;
};

type TradeRow = {
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

type PriceRow = {
  id: number;
  cycle_id: string;
  fetched_at: string | null;
  source: string;
  price_display: string | null;
  accepted: boolean;
  selected: boolean;
  reason: string | null;
};

type DbDump = {
  now: string;
  balances: BalanceRow[];
  settings: SettingsRow[];
  quotes: QuoteRow[];
  trades: TradeRow[];
  prices: PriceRow[];
};

export default function DbPage() {
  const [data, setData] = useState<DbDump | null>(null);
  const [failed, setFailed] = useState(false);

  const poll = useCallback(() => {
    fetch(`${API}/api/db`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json && !json.error) {
          setData(json as DbDump);
          setFailed(false);
        }
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [poll]);

  return (
    <AppShell
      title="Live database"
      sub={
        data ? (
          <>
            Every table, newest first. Refreshed {new Date(data.now).toLocaleTimeString()}
            {failed ? " · last poll failed, retrying" : ""}
          </>
        ) : (
          "Every table, newest first · polling every 2 seconds"
        )
      }
    >
      <div className="stack" style={{ marginTop: 24 }}>
        <LedgerCard balances={data?.balances ?? null} />
        <SettingsTableCard rows={data?.settings ?? null} />
        <QuotesTableCard rows={data?.quotes ?? null} />
        <TradesTableCard rows={data?.trades ?? null} />
        <PricesTableCard rows={data?.prices ?? null} />
      </div>
    </AppShell>
  );
}

type CardProps = { children: React.ReactNode; title: string; note: string };

function Card({ title, note, children }: CardProps) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        <span className="card-note">{note}</span>
      </div>
      {children}
    </section>
  );
}

function LedgerCard({ balances }: { balances: BalanceRow[] | null }) {
  return (
    <Card title="balances" note="one row per balance · paisa / microgram">
      {balances === null ? (
        <Empty>Connecting to the database…</Empty>
      ) : (
        <table className="db-table">
          <thead>
            <tr>
              <th>key</th>
              <th>unit</th>
              <th className="num">amount (minor units)</th>
              <th className="num">display</th>
              <th>updated</th>
            </tr>
          </thead>
          <tbody>
            {balances.map((b) => (
              <tr key={b.key}>
                <td>{b.key}</td>
                <td className="dim">{b.unit}</td>
                <td className="num">{b.amount_minor.toLocaleString()}</td>
                <td className="num">{b.display}</td>
                <td className="dim">{b.updated_at ? new Date(b.updated_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function SettingsTableCard({ rows }: { rows: SettingsRow[] | null }) {
  const s = rows?.[0] ?? null;
  return (
    <Card title="settings" note="single row · the operator controls on the User page write here">
      {s === null ? (
        <Empty>{rows === null ? "Connecting to the database…" : "No settings row, run the seed."}</Empty>
      ) : (
        <table className="db-table">
          <thead>
            <tr>
              <th>guardrail PKR/g</th>
              <th className="num">ttl (s)</th>
              <th className="num">divergence (bps)</th>
              <th className="num">max age (s)</th>
              <th className="num">fetch (s)</th>
              <th>source A</th>
              <th>source B</th>
              <th>source C</th>
              <th className="num">basis (bps)</th>
              <th>override PKR/g</th>
              <th>paused</th>
              <th>updated</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="num">{s.guardrail_pkr_per_gram}</td>
              <td className="num">{s.quote_ttl_seconds}</td>
              <td className="num">{s.divergence_threshold_bps}</td>
              <td className="num">{s.max_price_age_seconds}</td>
              <td className="num">{s.price_fetch_interval_seconds}</td>
              <td>
                <Bool on={s.source_a_on} />
              </td>
              <td>
                <Bool on={s.source_b_on} />
              </td>
              <td>
                <Bool on={s.source_c_on} />
              </td>
              <td className="num">{s.source_c_basis_bps}</td>
              <td>{s.price_override_pkr_per_gram === null ? "—" : s.price_override_pkr_per_gram}</td>
              <td>
                <Bool on={s.force_paused} />
              </td>
              <td className="dim">{s.updated_at ? new Date(s.updated_at).toLocaleTimeString() : "—"}</td>
            </tr>
          </tbody>
        </table>
      )}
    </Card>
  );
}

function QuotesTableCard({ rows }: { rows: QuoteRow[] | null }) {
  return (
    <Card title="quotes" note="latest 25 · newest first">
      {rows === null ? (
        <Empty>Connecting…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No quotes yet. Create one on the User page.</Empty>
      ) : (
        <div className="db-scroll">
          <table className="db-table">
            <thead>
              <tr>
                <th>status</th>
                <th>side</th>
                <th className="num">input</th>
                <th className="num">gold</th>
                <th className="num">PKR</th>
                <th className="num">exec PKR/g</th>
                <th>guardrail</th>
                <th>source</th>
                <th>created</th>
                <th>expires</th>
                <th>rejection</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.id}>
                  <td>
                    <QuoteStatus status={q.status} />
                  </td>
                  <td>{q.side}</td>
                  <td className="num">
                    {q.input_display} {q.input_mode}
                  </td>
                  <td className="num">{q.gold_display}</td>
                  <td className="num">{q.pkr_display}</td>
                  <td className="num">{q.execution_display}</td>
                  <td>{q.guardrail_applied ? "stored" : "—"}</td>
                  <td className="dim">{q.price_source}</td>
                  <td className="dim">{q.created_at ? new Date(q.created_at).toLocaleTimeString() : "—"}</td>
                  <td className="dim">{q.expires_at ? new Date(q.expires_at).toLocaleTimeString() : "—"}</td>
                  <td className="dim">{q.rejection_reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function TradesTableCard({ rows }: { rows: TradeRow[] | null }) {
  return (
    <Card title="trades" note="the receipts · immutable, one per confirmed quote">
      {rows === null ? (
        <Empty>Connecting…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No trades yet. Confirm a quote and the receipt appears here.</Empty>
      ) : (
        <div className="db-scroll">
          <table className="db-table">
            <thead>
              <tr>
                <th>side</th>
                <th className="num">gold</th>
                <th className="num">PKR</th>
                <th className="num">exec PKR/g</th>
                <th className="num">market PKR/g</th>
                <th>source</th>
                <th>settled</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>{t.side}</td>
                  <td className="num">{t.gold_display}</td>
                  <td className="num">{t.pkr_display}</td>
                  <td className="num">{t.unit_display}</td>
                  <td className="num">{t.market_display}</td>
                  <td className="dim">{t.price_source}</td>
                  <td className="dim">{new Date(t.settled_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PricesTableCard({ rows }: { rows: PriceRow[] | null }) {
  return (
    <Card title="prices" note="latest 30 source rows, grouped by fetch cycle · selected = the price the app used">
      {rows === null ? (
        <Empty>Connecting…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No price cycles yet. Hit “Force price fetch” on the User page.</Empty>
      ) : (
        <div className="db-scroll">
          <table className="db-table">
            <thead>
              <tr>
                <th>cycle time</th>
                <th>source</th>
                <th className="num">PKR/g</th>
                <th>accepted</th>
                <th>selected</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="dim">{p.fetched_at ? new Date(p.fetched_at).toLocaleString() : "—"}</td>
                  <td>{p.source}</td>
                  <td className="num">{p.price_display ?? "—"}</td>
                  <td>
                    <Bool on={p.accepted} />
                  </td>
                  <td>
                    <Bool on={p.selected} />
                  </td>
                  <td className="dim">{p.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ helpers */

function Bool({ on }: { on: boolean }) {
  return (
    <span className="status-chip">
      <span className={`status-dot ${on ? "status-ok" : "status-warn"}`} aria-hidden="true" />
      {on ? "yes" : "no"}
    </span>
  );
}

function QuoteStatus({ status }: { status: string }) {
  const dotClass =
    status === "active"
      ? "status-ok"
      : status === "settled"
        ? "status-warn"
        : "status-bad";
  const color =
    status === "settled"
      ? "var(--ink)"
      : status === "rejected"
        ? "var(--danger)"
        : "inherit";
  return (
    <span className="status-chip" style={{ color }}>
      <span className={`status-dot ${dotClass}`} aria-hidden="true" />
      {status}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: "12px 16px 16px", fontSize: 13, color: "var(--muted)" }}>{children}</p>
  );
}
