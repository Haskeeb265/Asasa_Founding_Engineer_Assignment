import { NextRequest, NextResponse } from "next/server";

export const CORS_ORIGIN = "*";

export function withCors<T>(response: NextResponse<T>): NextResponse<T> {
  response.headers.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept",
  );
  return response;
}

export function tryPreflight(request: NextRequest): NextResponse | null {
  if (request.method !== "OPTIONS") return null;
  return withCors(
    new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": CORS_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
      },
    }),
  );
}
