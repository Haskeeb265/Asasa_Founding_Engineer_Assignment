import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AmountError, toWire } from '../domain/units';
import { withCors } from './cors';

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'INVALID_AMOUNT'
  | 'TOO_MANY_DECIMALS'
  | 'AMOUNT_NOT_POSITIVE'
  | 'BELOW_MIN'
  | 'ABOVE_MAX'
  | 'NOT_FOUND'
  | 'INSUFFICIENT_PKR'
  | 'INSUFFICIENT_GOLD'
  | 'INSUFFICIENT_INVENTORY'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_CANCELLED'
  | 'QUOTE_SETTLED'
  | 'QUOTE_REJECTED'
  | 'TRADING_PAUSED'
  | 'PRICE_UNAVAILABLE'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  INVALID_AMOUNT: 400,
  TOO_MANY_DECIMALS: 400,
  AMOUNT_NOT_POSITIVE: 400,
  BELOW_MIN: 400,
  ABOVE_MAX: 400,
  NOT_FOUND: 404,
  INSUFFICIENT_PKR: 409,
  INSUFFICIENT_GOLD: 409,
  INSUFFICIENT_INVENTORY: 409,
  QUOTE_EXPIRED: 409,
  QUOTE_CANCELLED: 409,
  QUOTE_SETTLED: 409,
  QUOTE_REJECTED: 409,
  TRADING_PAUSED: 503,
  PRICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, hint?: string, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code] ?? 500;
  }
}

export function errorBody(error: AppError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.detail !== undefined ? { detail: toWire(error.detail) } : {}),
    },
  };
}

export function jsonOk(data: unknown, status = 200): Response {
  return withCors(
    NextResponse.json(toWire(data) as Record<string, unknown>, { status }),
  );
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new AppError('BAD_REQUEST', 'Request body must be valid JSON.');
  }
}

function isPgError(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof AmountError) {
    return new AppError(error.code, error.message);
  }

  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const path = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    return new AppError('BAD_REQUEST', `${path}${issue?.message ?? 'Invalid request.'}`);
  }

  if (isPgError(error)) {
    if (error.code === '23514') {
      // A CHECK violation here is a bug, not a user error.
      console.error('Database CHECK violation:', error.message);
      return new AppError('INTERNAL', 'The trade could not be applied safely.');
    }
    if (error.code === '23505') {
      return new AppError('INTERNAL', 'A duplicate record was detected.');
    }
    console.error('Database error:', error.message);
    return new AppError('INTERNAL', 'The database request failed.');
  }

  console.error('Unhandled error:', error instanceof Error ? error.message : error);
  return new AppError('INTERNAL', 'An unexpected error occurred.');
}

type RouteContext = { params: Promise<any> };

/**
 * One wrapper for every route: typed errors -> status table, everything else
 * -> a generic INTERNAL, and CORS headers on every response.
 */
export function handle(
  fn: (req: Request, ctx: RouteContext) => Promise<Response>,
): (req: Request, ctx: RouteContext) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return withCors(await fn(req, ctx));
    } catch (error) {
      const appError = toAppError(error);
      return withCors(
        NextResponse.json(errorBody(appError), { status: appError.status }),
      );
    }
  };
}
