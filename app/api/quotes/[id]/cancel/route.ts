import { z } from 'zod';
import { corsOptions } from '../../../../../server/cors';
import { handle, jsonOk, AppError } from '../../../../../server/http';
import { cancelQuote } from '../../../../../server/quotes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uuidSchema = z.string().uuid();

export const POST = handle(async (_req, ctx) => {
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) {
    throw new AppError('BAD_REQUEST', 'Quote id must be a UUID.');
  }

  const result = await cancelQuote(id);
  return jsonOk({ quote: result.quote, now: new Date() });
});

export const OPTIONS = corsOptions;
