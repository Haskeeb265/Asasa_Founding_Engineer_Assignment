import type { SourceId } from '../../domain/quorum';
import type { SettingsRow } from '../db/repo';
import type { PriceSnapshot } from './cycle';

export function sourceLabel(
  source: SourceId | null,
  kind: 'live' | 'override',
): string {
  if (kind === 'override') return 'Demo price override';
  switch (source) {
    case 'A_pakgold':
      return 'PakGold (gold-api × er-api)';
    case 'B_goldprice':
      return 'GoldPrice.org';
    case 'C_yahoo':
      return 'Yahoo Finance GC=F (basis-adjusted)';
    default:
      return 'No source';
  }
}

export function isSourceEnabled(settings: SettingsRow, source: SourceId): boolean {
  if (source === 'A_pakgold') return settings.sourceAOn;
  if (source === 'B_goldprice') return settings.sourceBOn;
  return settings.sourceCOn;
}

export interface GateResult {
  ok: boolean;
  code: 'PRICE_UNAVAILABLE' | 'TRADING_PAUSED' | null;
  message: string;
  hint: string | null;
}

const OPEN: GateResult = {
  ok: true,
  code: null,
  message: 'Trading is open.',
  hint: null,
};

/**
 * One verdict shared by POST /api/quotes and GET /api/state so the refusal and
 * the banner can never disagree. Availability is evaluated at read time, so
 * switching a source off takes effect immediately.
 */
export function evaluateGate(
  snapshot: PriceSnapshot | null,
  settings: SettingsRow,
  now: Date,
): GateResult {
  const override = snapshot?.kind === 'override';

  if (!override) {
    const available =
      snapshot === null
        ? []
        : snapshot.samples.filter(
            (sample) =>
              sample.accepted &&
              sample.price_paisa_per_gram !== null &&
              isSourceEnabled(settings, sample.source),
          );

    if (snapshot === null || available.length === 0) {
      return {
        ok: false,
        code: 'PRICE_UNAVAILABLE',
        message: 'No price source is reporting, so trading is paused.',
        hint: null,
      };
    }

    if (available.length === 1) {
      return {
        ok: false,
        code: 'PRICE_UNAVAILABLE',
        message: 'The price is unreliable and cannot be validated.',
        hint: `Only ${sourceLabel(available[0].source, 'live')} is available; at least two sources must agree.`,
      };
    }
  }

  if (settings.forcePaused) {
    return {
      ok: false,
      code: 'TRADING_PAUSED',
      message: 'Trading is paused by the demo control.',
      hint: 'Set pause to off in the demo controls to resume.',
    };
  }

  if (snapshot === null) {
    return {
      ok: false,
      code: 'PRICE_UNAVAILABLE',
      message: 'No price source is reporting, so trading is paused.',
      hint: null,
    };
  }

  const ageSeconds = Math.max(
    0,
    Math.floor((now.getTime() - snapshot.fetched_at.getTime()) / 1000),
  );
  if (ageSeconds > settings.maxPriceAgeSeconds) {
    return {
      ok: false,
      code: 'PRICE_UNAVAILABLE',
      message: 'The latest price is too old to trade.',
      hint: `Price is ${ageSeconds}s old; the maximum is ${settings.maxPriceAgeSeconds}s.`,
    };
  }

  return OPEN;
}
