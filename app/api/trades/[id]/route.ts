import { z } from 'zod';
import { corsOptions } from '../../../../server/cors';
import {
  getBalances,
  getTradeById,
  listTradesAtOrAfter,
} from '../../../../server/db/repo';
import { handle, jsonOk, AppError } from '../../../../server/http';
import { walkReceipts } from '../../../../server/receipts';
import { tradeView } from '../../../../server/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uuidSchema = z.string().uuid();

export const GET = handle(async (_req, ctx) => {
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) {
    throw new AppError('BAD_REQUEST', 'Trade id must be a UUID.');
  }

  const trade = await getTradeById(id);
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found.');

  const [balances, laterTrades] = await Promise.all([
    getBalances(),
    listTradesAtOrAfter(trade.settledAt),
  ]);
  const receipts = walkReceipts(laterTrades, balances);
  const receipt = receipts.find((item) => item.trade.id === trade.id);

  if (!receipt) {
    throw new AppError(
      'INTERNAL',
      'Could not reconstruct the receipt for this trade.',
    );
  }

  return jsonOk({
    receipt: {
      ...tradeView(receipt.trade),
      balances_before: receipt.balances_before,
      balances_after: receipt.balances_after,
    },
    now: new Date(),
  });
});

export const OPTIONS = corsOptions;
