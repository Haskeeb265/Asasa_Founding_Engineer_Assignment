import { corsOptions } from '../../../server/cors';
import { getSettings } from '../../../server/db/repo';
import { handle, jsonOk } from '../../../server/http';
import { peekPrice } from '../../../server/pricing/price';
import { evaluateGate } from '../../../server/pricing/settings-like';
import { pricePanelView } from '../../../server/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const now = new Date();
  const settings = await getSettings();
  const snapshot = await peekPrice();
  const gate = evaluateGate(snapshot, settings, now);

  return jsonOk({
    now,
    price: pricePanelView(snapshot, settings, now),
    gate: {
      ok: gate.ok,
      code: gate.code,
      message: gate.message,
      hint: gate.hint,
    },
  });
});

export const OPTIONS = corsOptions;
