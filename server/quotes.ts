import {
  MICRO,
  formatGrams,
  formatPkr,
  parseGrams,
  parsePkr,
} from '../domain/units';
import {
  BUY_SPREAD_BPS,
  SELL_SPREAD_BPS,
  ceilDiv,
  checkLimits,
  computeBuyFromGrams,
  computeBuyFromPkr,
  computeSellFromGrams,
  computeSellFromPkr,
  unitPrice,
  type InputMode,
  type Side,
} from '../domain/trade-math';
import {
  getBalances,
  getQuote,
  getQuoteByIdempotent,
  getSettings,
  insertQuote,
  cancelQuoteRow,
  confirmQuoteRow,
  settleQuote,
  sweepQuotes,
  type QuoteRow,
} from './db/repo';
import { AppError } from './http';
import { getPrice } from './pricing/price';
import { evaluateGate } from './pricing/settings-like';

export interface CreateQuoteRequest {
  side: Side;
  inputMode: InputMode;
  input: string;
  fromQuoteId?: string;
}

export interface CreateQuoteResult {
  quote: QuoteRow;
  priceChangeBps: number | null;
  now: Date;
}

export async function createQuote(
  request: CreateQuoteRequest,
): Promise<CreateQuoteResult> {
  const inputMinor =
    request.inputMode === 'pkr' ? parsePkr(request.input) : parseGrams(request.input);

  const settings = await getSettings();
  const snapshot = await getPrice();
  const now = new Date();
  const gate = evaluateGate(snapshot, settings, now);
  if (!gate.ok) {
    throw new AppError(
      gate.code ?? 'PRICE_UNAVAILABLE',
      gate.message,
      gate.hint ?? undefined,
    );
  }
  if (!snapshot || snapshot.source === null || snapshot.paisa_per_gram === null) {
    throw new AppError(
      'PRICE_UNAVAILABLE',
      'No price source is reporting, so trading is paused.',
    );
  }

  const unit = unitPrice(
    request.side,
    snapshot.paisa_per_gram,
    settings.guardrailPaisaPerGram,
  );

  const amounts =
    request.side === 'buy'
      ? request.inputMode === 'pkr'
        ? computeBuyFromPkr(inputMinor, unit.price)
        : computeBuyFromGrams(inputMinor, unit.price)
      : request.inputMode === 'pkr'
        ? computeSellFromPkr(inputMinor, unit.price)
        : computeSellFromGrams(inputMinor, unit.price);

  const limits = checkLimits({
    side: request.side,
    inputMode: request.inputMode,
    inputMinor,
    goldMicrograms: amounts.goldMicrograms,
    pkrPaisa: amounts.pkrPaisa,
  });
  if (!limits.ok) {
    throw new AppError(limits.code ?? 'BELOW_MIN', limits.message);
  }

  const balances = await getBalances();
  if (request.side === 'buy') {
    const maxGoldVsCash = (balances.pkrPaisa * MICRO) / unit.price;
    const maxPkrVsInventory = ceilDiv(
      balances.platformGoldMicrograms * unit.price,
      MICRO,
    );
    const maxPkrPaisa =
      balances.pkrPaisa < maxPkrVsInventory
        ? balances.pkrPaisa
        : maxPkrVsInventory;
    const maxGoldMicrograms =
      maxGoldVsCash < balances.platformGoldMicrograms
        ? maxGoldVsCash
        : balances.platformGoldMicrograms;
    const detail = {
      max_pkr_paisa: maxPkrPaisa,
      max_gold_micrograms: maxGoldMicrograms,
    };

    if (amounts.pkrPaisa > balances.pkrPaisa) {
      throw new AppError(
        'INSUFFICIENT_PKR',
        'Your PKR balance is not enough for this trade.',
        `You can spend up to ${formatPkr(maxPkrPaisa)}.`,
        detail,
      );
    }
    if (amounts.goldMicrograms > balances.platformGoldMicrograms) {
      throw new AppError(
        'INSUFFICIENT_INVENTORY',
        'The platform inventory is not enough for this trade.',
        `You can buy up to ${formatGrams(maxGoldMicrograms)}.`,
        detail,
      );
    }
  } else {
    const maxPkrPaisa = (balances.userGoldMicrograms * unit.price) / MICRO;
    const detail = {
      max_gold_micrograms: balances.userGoldMicrograms,
      max_pkr_paisa: maxPkrPaisa,
    };

    if (amounts.goldMicrograms > balances.userGoldMicrograms) {
      throw new AppError(
        'INSUFFICIENT_GOLD',
        'Your gold balance is not enough for this trade.',
        `You can sell up to ${formatGrams(balances.userGoldMicrograms)}.`,
        detail,
      );
    }
  }

  let priceChangeBps: number | null = null;
  if (request.fromQuoteId) {
    const previous = await getQuote(request.fromQuoteId);
    if (previous && previous.side === request.side) {
      const delta =
        ((unit.price - previous.unitPaisaPerGram) * 10_000n) /
        previous.unitPaisaPerGram;
      priceChangeBps = Number(delta);
    }
  }

  const quote = await insertQuote({
    side: request.side,
    inputMode: request.inputMode,
    inputMinor,
    marketPaisaPerGram: snapshot.paisa_per_gram,
    unitPaisaPerGram: unit.price,
    spreadBps: request.side === 'buy' ? BUY_SPREAD_BPS : SELL_SPREAD_BPS,
    goldMicrograms: amounts.goldMicrograms,
    pkrPaisa: amounts.pkrPaisa,
    guardrailPaisaPerGram: settings.guardrailPaisaPerGram,
    guardrailApplied: unit.guardrailApplied,
    priceSource: snapshot.source,
    priceCycleId: snapshot.cycle_id,
    priceFetchedAt: snapshot.fetched_at,
    ttlSeconds: settings.quoteTtlSeconds,
  });

  return { quote, priceChangeBps, now: new Date() };
}

export interface ConfirmResult {
  confirmed: true;
  replayed: boolean;
  quote: QuoteRow;
  tradeId: string | null;
  now: Date;
}

export async function confirmQuote(id: string): Promise<ConfirmResult> {
  let updated = await confirmQuoteRow(id);
  if (!updated) updated = await confirmQuoteRow(id);

  if (updated) {
    return {
      confirmed: true,
      replayed: false,
      quote: updated,
      tradeId: null,
      now: new Date(),
    };
  }

  const found = await getQuoteByIdempotent(id);
  if (!found) throw new AppError('NOT_FOUND', 'Quote not found.');

  const { quote, trade } = found;
  if (quote.status === 'confirmed') {
    return {
      confirmed: true,
      replayed: true,
      quote,
      tradeId: null,
      now: new Date(),
    };
  }
  if (quote.status === 'settled') {
    return {
      confirmed: true,
      replayed: true,
      quote,
      tradeId: trade?.id ?? null,
      now: new Date(),
    };
  }
  if (quote.status === 'active') {
    // Expired between the conditional update and the read: expire it now.
    await sweepQuotes();
    throw new AppError(
      'QUOTE_EXPIRED',
      'This quote has expired. Request a new quote.',
    );
  }
  if (quote.status === 'cancelled') {
    throw new AppError('QUOTE_CANCELLED', 'This quote was cancelled.');
  }
  if (quote.status === 'rejected') {
    throw new AppError(
      'QUOTE_REJECTED',
      'This quote was rejected.',
      quote.rejectionReason ?? undefined,
    );
  }
  throw new AppError('QUOTE_EXPIRED', 'This quote can no longer be confirmed.');
}

export async function cancelQuote(
  id: string,
): Promise<{ quote: { id: string; status: 'cancelled' } }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cancelled = await cancelQuoteRow(id);
    if (cancelled) return { quote: cancelled };

    const quote = await getQuote(id);
    if (!quote) throw new AppError('NOT_FOUND', 'Quote not found.');

    if (quote.status === 'cancelled') {
      return { quote: { id, status: 'cancelled' } };
    }
    if (quote.status === 'settled') {
      throw new AppError('QUOTE_SETTLED', 'This quote has already settled.');
    }
    if (quote.status === 'expired') {
      throw new AppError('QUOTE_EXPIRED', 'This quote has expired.');
    }
    if (quote.status === 'rejected') {
      throw new AppError(
        'QUOTE_REJECTED',
        'This quote was rejected.',
        quote.rejectionReason ?? undefined,
      );
    }
    if (quote.status === 'active' && quote.isDue) {
      await sweepQuotes();
      throw new AppError('QUOTE_EXPIRED', 'This quote has expired.');
    }
    if (quote.status === 'confirmed' && quote.isDue) {
      const outcome = await settleQuote(id);
      if (outcome.kind === 'settled') {
        throw new AppError(
          'QUOTE_SETTLED',
          'The timer ran out and this quote has already settled.',
        );
      }
      if (outcome.kind === 'shortfall') {
        throw new AppError(
          'QUOTE_REJECTED',
          'Settlement found an insufficient balance; the quote was rejected.',
          outcome.error.hint,
          outcome.error.detail,
        );
      }
      throw new AppError('QUOTE_SETTLED', 'This quote is settling.');
    }
    // Active or confirmed and not due: another request may have just won the
    // conditional update. Try once more.
  }

  throw new AppError('INTERNAL', 'Could not cancel the quote; please retry.');
}
