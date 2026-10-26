import { NextResponse } from "next/server";
import { withCors } from "./cors";

/**
 * The error contract (§9): the client switches exhaustively on these codes,
 * and every failure renders a real affordance instead of a blank screen.
 */
export type ErrorCode =
  | "INVALID_AMOUNT"
  | "TOO_MANY_DECIMALS"
  | "AMOUNT_NOT_POSITIVE"
  | "BELOW_MIN"
  | "ABOVE_MAX"
  | "INSUFFICIENT_PKR"
  | "INSUFFICIENT_GOLD"
  | "INSUFFICIENT_INVENTORY"
  | "QUOTE_EXPIRED"
  | "QUOTE_CANCELLED"
  | "QUOTE_SETTLED"
  | "QUOTE_REJECTED"
  | "TRADING_PAUSED"
  | "PRICE_UNAVAILABLE"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "INTERNAL";

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  INSUFFICIENT_PKR: 409,
  INSUFFICIENT_GOLD: 409,
  INSUFFICIENT_INVENTORY: 409,
  QUOTE_EXPIRED: 409,
  QUOTE_CANCELLED: 409,
  QUOTE_SETTLED: 409,
  QUOTE_REJECTED: 409,
  TRADING_PAUSED: 503,
  PRICE_UNAVAILABLE: 503,
  NOT_FOUND: 404,
};

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  hint?: string;
  detail?: Record<string, unknown>;
}

export function errorJson(
  body: ErrorBody,
  statusOverride?: number,
): NextResponse<{ error: ErrorBody }> {
  const status = statusOverride ?? STATUS_BY_CODE[body.code] ?? 400;
  return withCors(NextResponse.json({ error: body }, { status }));
}
