import { corsOptions } from '../../../server/cors';
import {
  getBalances,
  getSettings,
  listPrices,
  listQuotes,
  listTrades,
} from '../../../server/db/repo';
import { handle, jsonOk } from '../../../server/http';
import {
  balanceView,
  priceRowView,
  quoteView,
  settingsView,
  tradeView,
} from '../../../server/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const [balances, settings, quotes, prices, trades] = await Promise.all([
    getBalances(),
    getSettings(),
    listQuotes(25),
    listPrices(30),
    listTrades(25),
  ]);
  const now = new Date();

  return jsonOk({
    now,
    balances: balanceView(balances),
    settings: settingsView(settings),
    quotes: quotes.map((quote) => quoteView(quote, now)),
    prices: prices.map(priceRowView),
    trades: trades.map(tradeView),
  });
});

export const OPTIONS = corsOptions;
