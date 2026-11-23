import { z } from 'zod';
import { corsOptions } from '../../../../../server/cors';
import { handle, jsonOk, AppError } from '../../../../../server/http';
import { confirmQuote } from '../../../../../server/quotes';
import { quoteView } from '../../../../../server/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uuidSchema = z.string().uuid();

export const POST = handle(async (_req, ctx) => {
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) {
    throw new AppError('BAD_REQUEST', 'Quote id must be a UUID.');
  }

  const result = await confirmQuote(id);
  return jsonOk({
    confirmed: true,
    replayed: result.replayed,
    quote: quoteView(result.quote, result.now),
    trade_id: result.tradeId,
    expires_at: result.quote.expiresAt,
    now: result.now,
  });
});

export const OPTIONS = corsOptions;
