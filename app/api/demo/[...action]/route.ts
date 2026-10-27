import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  DEMO_SEED,
  getSettings,
  resetDemo,
  setBalance,
  updateSettings,
  type BalanceKey,
} from "../../../../server/db/repo";
import { parseMinor } from "../../../../domain/units";
import { errorJson } from "../../../../server/http";
import { KEY_CURRENT, KEY_NEXT_FETCH_AT, kvDelete } from "../../../../server/pricing/redis";
import { settingsWire } from "../../../../server/serialize";
import { tryPreflight, withCors } from "../../../../server/cors";

export const dynamic = "force-dynamic";

/**
 * Demo controls (§8), public, clearly labelled "not part of the product".
 * Paths: /api/demo/{action}, action in:
 *   toggle-source  { source: 'a'|'b'|'c', on: boolean }   — source A/B/C on/off
 *   pause          { on: boolean }                         — force_paused
 *   guardrail      { value }                               — guardrail PKR/g (2 dp)
 *   threshold      { bps }                                 — divergence threshold 1..5000
 *   ttl            { seconds }                             — quote TTL 1..3600
 *   max-price-age  { seconds }                             — max price age 60..3600
 *   basis          { bps }                                 — source C basis -500..500
 *   override       { value | null }                        — price override PKR/g, null clears
 *   set-balance    { key: 'pkr'|'user_gold'|'platform_gold', value }  — paisa 2 dp / grams 6 dp
 *   force-cycle    { }                                     — clear Redis cooldown, refetch immediately
 *   reset          { }                                     — reseed balances, clear quotes/trades
 */
const bodySchema = z.object({
  source: z.enum(["a", "b", "c"]).optional(),
  on: z.boolean().optional(),
  value: z.union([z.string(), z.number()]).nullable().optional(),
  bps: z.number().int().optional(),
  seconds: z.number().int().optional(),
  key: z.enum(["pkr", "user_gold", "platform_gold"]).optional(),
});

async function handle(json: unknown, action: string): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(json ?? {});
  if (!parsed.success) {
    return errorJson({
      code: "BAD_REQUEST",
      message: "Invalid demo-control body.",
      hint: parsed.error.issues.map((i) => i.message).join("; "),
    });
  }
  const body = parsed.data;

  switch (action) {
    case "toggle-source": {
      if (!body.source || typeof body.on !== "boolean") {
        return errorJson({ code: "BAD_REQUEST", message: "Send { source: 'a'|'b'|'c', on: boolean }." });
      }
      const column =
        body.source === "a"
          ? ({ sourceAOn: body.on } as const)
          : body.source === "b"
            ? ({ sourceBOn: body.on } as const)
            : ({ sourceCOn: body.on } as const);
      await updateSettings(column);
      break;
    }
    case "pause": {
      if (typeof body.on !== "boolean") {
        return errorJson({ code: "BAD_REQUEST", message: "Send { on: boolean }." });
      }
      await updateSettings({ forcePaused: body.on });
      break;
    }
    case "guardrail": {
      const parsedValue = parseMinor(body.value ?? undefined, 2, "guardrail");
      if (!parsedValue.ok) return errorJson({ code: parsedValue.code, message: parsedValue.message });
      await updateSettings({ guardrailPaisaPerGram: parsedValue.value });
      break;
    }
    case "threshold": {
      const bps = body.bps;
      if (typeof bps !== "number" || bps < 1 || bps > 5000) {
        return errorJson({ code: "BAD_REQUEST", message: "Send bps between 1 and 5000." });
      }
      await updateSettings({ divergenceThresholdBps: bps });
      break;
    }
    case "ttl": {
      const seconds = body.seconds;
      if (typeof seconds !== "number" || seconds < 1 || seconds > 3600) {
        return errorJson({ code: "BAD_REQUEST", message: "Send seconds between 1 and 3600." });
      }
      await updateSettings({ quoteTtlSeconds: seconds });
      break;
    }
    case "max-price-age": {
      const seconds = body.seconds;
      if (typeof seconds !== "number" || seconds < 60 || seconds > 3600) {
        return errorJson({ code: "BAD_REQUEST", message: "Send seconds between 60 and 3600." });
      }
      await updateSettings({ maxPriceAgeSeconds: seconds });
      break;
    }
    case "basis": {
      const bps = body.bps;
      if (typeof bps !== "number" || bps < -500 || bps > 500 || !Number.isInteger(bps)) {
        return errorJson({ code: "BAD_REQUEST", message: "Send integer bps between -500 and 500." });
      }
      await updateSettings({ sourceCBasisBps: bps });
      break;
    }
    case "override": {
      if (body.value === null || body.value === undefined || body.value === "") {
        await updateSettings({ priceOverridePaisa: null });
        break;
      }
      const parsedValue = parseMinor(body.value, 2, "price override");
      if (!parsedValue.ok) return errorJson({ code: parsedValue.code, message: parsedValue.message });
      await updateSettings({ priceOverridePaisa: parsedValue.value });
      break;
    }
    case "set-balance": {
      const key = body.key;
      if (!key) return errorJson({ code: "BAD_REQUEST", message: "Send { key, value }." });
      const decimals = key === "pkr" ? 2 : 6;
      const parsedValue = parseMinor(body.value ?? undefined, decimals, `balance ${key}`);
      if (!parsedValue.ok) return errorJson({ code: parsedValue.code, message: parsedValue.message });
      await setBalance(key as BalanceKey, parsedValue.value);
      break;
    }
    case "force-cycle": {
      await kvDelete(KEY_NEXT_FETCH_AT);
      await kvDelete(KEY_CURRENT);
      break;
    }
    case "reset": {
      await resetDemo();
      await updateSettings({ forcePaused: false, priceOverridePaisa: null });
      await kvDelete(KEY_NEXT_FETCH_AT);
      await kvDelete(KEY_CURRENT);
      break;
    }
    default:
      return errorJson({ code: "NOT_FOUND", message: `Unknown demo action '${action}'.` }, 404);
  }

  const settings = await getSettings();
  return NextResponse.json({ ok: true, seed_shape: DEMO_SEED.pkrPaisa > 0n, settings: settingsWire(settings) });
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ action: string[] }> }) {
  const preflight = tryPreflight(request);
  if (preflight) return preflight;

  const { action } = await ctx.params;
  const name = action?.[0] ?? "";

  try {
    const json = await request.json().catch(() => ({}));
    return withCors(await handle(json, name));
  } catch (err) {
    console.error("[POST /api/demo]", err);
    return withCors(
      NextResponse.json(
        { error: { code: "INTERNAL", message: "Demo action failed." } },
        { status: 500 },
      ),
    );
  }
}
