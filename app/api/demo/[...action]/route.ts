import { z } from 'zod';
import { corsOptions } from '../../../../server/cors';
import {
  getSettings,
  resetDemo,
  setBalance,
  updateSettings,
} from '../../../../server/db/repo';
import { AppError, handle, jsonOk, readJson } from '../../../../server/http';
import { forceCycle, invalidatePriceCache } from '../../../../server/pricing/price';
import { settingsView, balanceView } from '../../../../server/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PKR_DECIMALS = 2;
const MAX_GRAM_DECIMALS = 6;

/** Non-negative amount parser (unlike trade input, 0 is allowed here). */
function parseNonNegative(raw: unknown, decimals: number, label: string): bigint {
  if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw)) {
    throw new AppError(
      'BAD_REQUEST',
      `${label} must be a non-negative decimal string.`,
    );
  }
  const [whole, frac = ''] = raw.split('.');
  if (frac.length > decimals) {
    throw new AppError(
      'BAD_REQUEST',
      `${label} accepts at most ${decimals} decimal place(s).`,
    );
  }
  return BigInt(whole) * 10n ** BigInt(decimals) +
    (frac.length > 0 ? BigInt(frac.padEnd(decimals, '0')) : 0n);
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      'BAD_REQUEST',
      parsed.error.issues[0]?.message ?? 'Invalid request body.',
      undefined,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

const toggleSourceSchema = z.object({
  source: z.enum(['a', 'b', 'c']),
  on: z.boolean(),
});
const pauseSchema = z.object({ on: z.boolean() });
const amountSchema = z.object({ value: z.string() });
const thresholdSchema = z.object({ bps: z.number().int().min(1).max(5000) });
const ttlSchema = z.object({ seconds: z.number().int().min(1).max(3600) });
const maxPriceAgeSchema = z.object({ seconds: z.number().int().min(1).max(3600) });
const fetchIntervalSchema = z.object({
  seconds: z.number().int().min(1).max(86400),
});
const basisSchema = z.object({ bps: z.number().int().min(-500).max(500) });
const overrideSchema = z.object({
  value: z.union([z.string(), z.null()]),
});
const setBalanceSchema = z.object({
  key: z.enum(['pkr', 'user_gold', 'platform_gold']),
  value: z.string(),
});

async function respond(): Promise<Response> {
  const settings = await getSettings();
  return jsonOk({ ok: true, settings: settingsView(settings) });
}

export const POST = handle(async (req, ctx) => {
  const { action } = await ctx.params;
  const name = Array.isArray(action) ? action[0] : action;

  switch (name) {
    case 'toggle-source': {
      const body = parseBody(toggleSourceSchema, await readJson(req));
      const patch =
        body.source === 'a'
          ? { sourceAOn: body.on }
          : body.source === 'b'
            ? { sourceBOn: body.on }
            : { sourceCOn: body.on };
      await updateSettings(patch);
      await invalidatePriceCache();
      return respond();
    }

    case 'pause': {
      const body = parseBody(pauseSchema, await readJson(req));
      await updateSettings({ forcePaused: body.on });
      return respond();
    }

    case 'guardrail': {
      const body = parseBody(amountSchema, await readJson(req));
      const value = parseNonNegative(body.value, MAX_PKR_DECIMALS, 'Guardrail');
      await updateSettings({ guardrailPaisaPerGram: value });
      return respond();
    }

    case 'threshold': {
      const body = parseBody(thresholdSchema, await readJson(req));
      await updateSettings({ divergenceThresholdBps: body.bps });
      await invalidatePriceCache();
      return respond();
    }

    case 'ttl': {
      const body = parseBody(ttlSchema, await readJson(req));
      await updateSettings({ quoteTtlSeconds: body.seconds });
      return respond();
    }

    case 'max-price-age': {
      const body = parseBody(maxPriceAgeSchema, await readJson(req));
      await updateSettings({ maxPriceAgeSeconds: body.seconds });
      return respond();
    }

    case 'fetch-interval': {
      const body = parseBody(fetchIntervalSchema, await readJson(req));
      await updateSettings({ priceFetchIntervalSeconds: body.seconds });
      await invalidatePriceCache();
      return respond();
    }

    case 'basis': {
      const body = parseBody(basisSchema, await readJson(req));
      await updateSettings({ sourceCBasisBps: body.bps });
      await invalidatePriceCache();
      return respond();
    }

    case 'override': {
      const body = parseBody(overrideSchema, await readJson(req));
      if (body.value === null) {
        await updateSettings({ priceOverridePaisa: null });
      } else {
        const value = parseNonNegative(
          body.value,
          MAX_PKR_DECIMALS,
          'Override price',
        );
        if (value <= 0n) {
          throw new AppError(
            'BAD_REQUEST',
            'Override price must be greater than zero, or null to clear it.',
          );
        }
        await updateSettings({ priceOverridePaisa: value });
      }
      await invalidatePriceCache();
      return respond();
    }

    case 'set-balance': {
      const body = parseBody(setBalanceSchema, await readJson(req));
      const value =
        body.key === 'pkr'
          ? parseNonNegative(body.value, MAX_PKR_DECIMALS, 'PKR balance')
          : parseNonNegative(body.value, MAX_GRAM_DECIMALS, 'Gold balance');
      const balances = await setBalance(body.key, value);
      const settings = await getSettings();
      return jsonOk({
        ok: true,
        balances: balanceView(balances),
        settings: settingsView(settings),
      });
    }

    case 'force-cycle': {
      const snapshot = await forceCycle();
      const settings = await getSettings();
      return jsonOk({
        ok: true,
        settings: settingsView(settings),
        price: {
          source: snapshot.source,
          paisa_per_gram: snapshot.paisa_per_gram,
          status: snapshot.status,
          degraded: snapshot.degraded,
          degraded_reason: snapshot.degraded_reason,
          samples: snapshot.samples,
        },
      });
    }

    case 'reset': {
      const balances = await resetDemo();
      await invalidatePriceCache();
      const settings = await getSettings();
      return jsonOk({
        ok: true,
        balances: balanceView(balances),
        settings: settingsView(settings),
      });
    }

    default:
      throw new AppError('NOT_FOUND', `Unknown demo action: ${name ?? 'none'}.`);
  }
});

export const OPTIONS = corsOptions;
