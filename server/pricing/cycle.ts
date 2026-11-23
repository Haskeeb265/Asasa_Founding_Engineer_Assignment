import { randomUUID } from 'node:crypto';
import {
  evaluate,
  type QuorumStatus,
  type SourceId,
} from '../../domain/quorum';
import {
  getAnchorPaisaPerGram,
  getSettings,
  insertPriceRows,
  type PriceInsert,
} from '../db/repo';
import { getUsdPkr, type FxResult } from '../sources/fx';
import { fetchGoldPriceOrg } from '../sources/goldprice-org';
import { fetchPakgold } from '../sources/pakgold';
import { failure, type Sample } from '../sources/types';
import { fetchYahooFutures } from '../sources/yahoo-futures';
import { sourceLabel } from './settings-like';

export interface SnapshotSample {
  source: SourceId;
  price_paisa_per_gram: bigint | null;
  accepted: boolean;
  selected: boolean;
  reason: string;
  provider_at: Date | null;
  note?: string;
}

export interface PriceSnapshot {
  cycle_id: string;
  fetched_at: Date;
  source: SourceId | null;
  paisa_per_gram: bigint | null;
  status: QuorumStatus;
  degraded: boolean;
  degraded_reason: string | null;
  samples: SnapshotSample[];
  kind: 'live' | 'override';
}

/**
 * One fetch cycle: every enabled source is attempted once, in parallel, then
 * the quorum decides. Failed and disabled sources still get a human `reason`
 * in their row (disabled sources are not fetched and get no row).
 */
export async function runCycle(): Promise<PriceSnapshot> {
  const settings = await getSettings();
  const needsFx = settings.sourceAOn || settings.sourceCOn;
  const fx: FxResult = needsFx
    ? await getUsdPkr()
    : { ok: false, reason: 'FX not needed' };

  const attempts: Array<Promise<Sample>> = [];
  const sources: SourceId[] = [];
  if (settings.sourceAOn) {
    sources.push('A_pakgold');
    attempts.push(fetchPakgold(fx));
  }
  if (settings.sourceBOn) {
    sources.push('B_goldprice');
    attempts.push(fetchGoldPriceOrg());
  }
  if (settings.sourceCOn) {
    sources.push('C_yahoo');
    attempts.push(fetchYahooFutures(fx, settings.sourceCBasisBps));
  }

  const settled = await Promise.allSettled(attempts);
  const samples: Sample[] = settled.map((result, index) => {
    const source = sources[index];
    if (result.status === 'fulfilled') return result.value;
    return failure(
      source,
      `source threw: ${
        result.reason instanceof Error ? result.reason.message : 'unknown error'
      }`,
    );
  });

  const anchor = await getAnchorPaisaPerGram();
  const okSamples = samples
    .filter(
      (sample): sample is Extract<Sample, { ok: true }> => sample.ok === true,
    )
    .map((sample) => ({
      source: sample.source,
      paisaPerGram: sample.paisaPerGram,
    }));

  const quorum = evaluate(okSamples, settings.divergenceThresholdBps, anchor);

  const fetchedAt = new Date();
  const cycleId = randomUUID();

  const rows: PriceInsert[] = samples.map((sample) => {
    const decision = quorum.decisions[sample.source];
    return {
      source: sample.source,
      pricePaisaPerGram: sample.ok ? sample.paisaPerGram : null,
      accepted: sample.ok ? decision.accepted : false,
      selected: sample.ok && quorum.selected === sample.source,
      reason: sample.ok ? decision.reason : sample.reason,
    };
  });

  await insertPriceRows(cycleId, fetchedAt, rows);

  const selectedSample = samples.find(
    (sample): sample is Extract<Sample, { ok: true }> =>
      sample.ok === true && sample.source === quorum.selected,
  );

  const selected = quorum.selected;
  const degraded = selected !== null && selected !== 'A_pakgold';
  let degradedReason: string | null = null;
  if (degraded && selected !== null) {
    const pakgold = samples.find((sample) => sample.source === 'A_pakgold');
    const why = !pakgold
      ? 'is disabled'
      : pakgold.ok
        ? 'was rejected by the quorum'
        : pakgold.reason;
    degradedReason = `PakGold ${why}; using ${sourceLabel(selected, 'live')}.`;
  }

  return {
    cycle_id: cycleId,
    fetched_at: fetchedAt,
    source: selected,
    paisa_per_gram: selectedSample?.paisaPerGram ?? null,
    status: quorum.status,
    degraded,
    degraded_reason: degradedReason,
    samples: samples.map((sample) => {
      const decision = quorum.decisions[sample.source];
      return {
        source: sample.source,
        price_paisa_per_gram: sample.ok ? sample.paisaPerGram : null,
        accepted: sample.ok ? decision.accepted : false,
        selected: sample.ok && quorum.selected === sample.source,
        reason: sample.ok ? decision.reason : sample.reason,
        provider_at: sample.ok ? sample.providerAt : null,
        ...(sample.ok && sample.note ? { note: sample.note } : {}),
      };
    }),
    kind: 'live',
  };
}
