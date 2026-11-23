import { z } from 'zod';
import { corsOptions } from '../../../server/cors';
import { handle, jsonOk, readJson, AppError } from '../../../server/http';
import { createQuote } from '../../../server/quotes';
import { quoteView } from '../../../server/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  side: z.enum(['buy', 'sell']),
  input_mode: z.enum(['pkr', 'grams']),
  input: z.string(),
  from_quote_id: z.string().uuid().optional(),
});

export const POST = handle(async (req) => {
  const raw = await readJson(req);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      'BAD_REQUEST',
      parsed.error.issues[0]?.message ?? 'Invalid quote request.',
      undefined,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  const result = await createQuote({
    side: parsed.data.side,
    inputMode: parsed.data.input_mode,
    input: parsed.data.input,
    fromQuoteId: parsed.data.from_quote_id,
  });

  return jsonOk(
    {
      quote: quoteView(result.quote, result.now),
      price_change_bps: result.priceChangeBps,
      now: result.now,
    },
    201,
  );
});

export const OPTIONS = corsOptions;
