import "server-only";

import { NextResponse } from "next/server";

export class FieldServicesError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "FieldServicesError";
    this.status = status;
  }
}

export function fieldServicesErrorResponse(err: unknown): NextResponse {
  if (err instanceof FieldServicesError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[field-services] unexpected error", err);
  return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
}
