"use client";

/**
 * Settings, in the shell's side panel and only while the User page is open.
 * Every control writes straight to the settings row through /api/demo/*, so
 * nothing here needs a redeploy. The demo's controls are the panel's whole
 * point, hence no auth dance.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

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

export function SettingsPanel() {
  const [settings, setSettings] = useState<SettingsWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<number | null>(null);

  const refetch = useCallback(() => {
    fetch(`${API}/api/state`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json && !json.error && json.settings) setSettings(json.settings as SettingsWire);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refetch();
    const t = setInterval(refetch, 5000);
    return () => {
      clearInterval(t);
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    };
  }, [refetch]);

  const fail = (message: string) => {
    setError(message);
    if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setError(null), 6000);
  };

  const patch = async (action: string, body: Record<string, unknown>) => {
    try {
      const res = await fetch(`${API}/api/demo/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (res.status !== 200) {
        const msg = json?.error?.hint
          ? `${json.error.message} ${json.error.hint}`
          : (json?.error?.message ?? "Setting failed to save.");
        fail(msg);
      } else if (json?.settings) {
        setSettings(json.settings as SettingsWire);
        setError(null);
      }
    } catch {
      fail("Network error while saving the setting.");
    }
    refetch();
  };

  return (
    <section className="sidebar-settings" aria-label="Settings">
      <div className="sidebar-settings-head">
        <h2 className="sidebar-settings-title">Settings</h2>
        <span className="sidebar-settings-note">written to the settings table, live</span>
      </div>

      {error ? (
        <p className="sidebar-settings-error" role="status">
          {error}
        </p>
      ) : null}

      <div className="settings-list">
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
              min={1}
              max={3600}
              step={1}
              suffix="s"
              inputLabel="Max price age"
              onCommit={(v) => patch("max-price-age", { seconds: v })}
            />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Price fetch interval" desc="seconds a price stays fresh before refetching">
          {settings ? (
            <NumberSetting
              value={settings.price_fetch_interval_seconds}
              min={1}
              max={86400}
              step={1}
              suffix="s"
              inputLabel="Price fetch interval"
              onCommit={(v) => patch("fetch-interval", { seconds: v })}
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
            <Toggle
              label={settings.force_paused ? "Paused" : "Running"}
              on={settings.force_paused}
              onClick={() => patch("pause", { on: !settings.force_paused })}
            />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Source A · PakGold.pk" desc="primary price source">
          {settings ? (
            <Toggle
              label={settings.source_a_on ? "On" : "Off"}
              on={settings.source_a_on}
              onClick={() => patch("toggle-source", { source: "a", on: !settings.source_a_on })}
            />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Source B · Goldprice.org" desc="fallback source">
          {settings ? (
            <Toggle
              label={settings.source_b_on ? "On" : "Off"}
              on={settings.source_b_on}
              onClick={() => patch("toggle-source", { source: "b", on: !settings.source_b_on })}
            />
          ) : (
            "—"
          )}
        </Row>

        <Row name="Source C · Yahoo" desc="validator only, never displayed">
          {settings ? (
            <Toggle
              label={settings.source_c_on ? "On" : "Off"}
              on={settings.source_c_on}
              onClick={() => patch("toggle-source", { source: "c", on: !settings.source_c_on })}
            />
          ) : (
            "—"
          )}
        </Row>

        <div className="sidebar-settings-actions">
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
