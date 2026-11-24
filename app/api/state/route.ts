import { corsOptions } from '../../../server/cors';
import {
  getBalances,
  getLiveQuote,
  getSettings,
  listSelectedPrices,
  listTrades,
  sweepQuotes,
} from '../../../server/db/repo';
import { handle, jsonOk } from '../../../server/http';
import { getPrice } from '../../../server/pricing/price';
import { evaluateGate } from '../../../server/pricing/settings-like';
import { walkReceipts } from '../../../server/receipts';
import {
  balanceView,
  pricePanelView,
  quoteView,
  settingsView,
  tradeView,
} from '../../../server/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  // Every read is also a sweep: a confirmed quote settles on the first read
  // after its timer runs out.
  await sweepQuotes();

  const settings = await getSettings();
  const snapshot = await getPrice();
  const gateNow = new Date();
  const gate = evaluateGate(snapshot, settings, gateNow);

  const balances = await getBalances();
  const quote = await getLiveQuote();
  const trades = await listTrades(10);
  const receipts = walkReceipts(trades, balances);
  const priceHistory = await listSelectedPrices(80);

  const withholdPrice = !gate.ok && gate.code === 'PRICE_UNAVAILABLE';

  return jsonOk({
    now: new Date(),
    balances: balanceView(balances),
    gate: {
      ok: gate.ok,
      code: gate.code,
      message: gate.message,
      hint: gate.hint,
    },
    price: withholdPrice ? null : pricePanelView(snapshot, settings, gateNow),
    price_notice:
      gate.code === 'PRICE_UNAVAILABLE'
        ? { code: gate.code, message: gate.message, hint: gate.hint }
        : null,
    quote: quote ? quoteView(quote, gateNow) : null,
    price_history: priceHistory.map((row) => ({
      fetched_at: row.fetchedAt,
      price_paisa_per_gram: row.pricePaisaPerGram,
      source: row.source,
    })),
    trades: receipts.map((receipt) => ({
      ...tradeView(receipt.trade),
      balances_before: receipt.balances_before,
      balances_after: receipt.balances_after,
    })),
    settings: settingsView(settings),
  });
});

export const OPTIONS = corsOptions;
