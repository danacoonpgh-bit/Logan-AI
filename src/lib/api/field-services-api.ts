import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import type { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { apiError, apiOk } from "@/lib/api/responses";
import type { ApiAuthContext } from "@/lib/api/auth";
import { tsToIso } from "@/lib/server/field-events";
import type { MaterialLine, TimeEntry } from "@/types/field-services";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
export const MAX_SCAN = 500;

export async function fieldApiGate(ctx: ApiAuthContext): Promise<NextResponse | null> {
  const snap = await getAdminDb().doc(`subAccounts/${ctx.subAccountId}`).get();
  if (!fieldServicesAvailable(snap.data())) {
    return apiError(
      ctx,
      "permission_error",
      "field_services_disabled",
      "Field Services isn't enabled for this workspace.",
    );
  }
  return null;
}

export function pageParams(request: Request): { limit: number; startingAfter: string | null } {
  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(MAX_LIMIT, Math.floor(raw)) : DEFAULT_LIMIT;
  return { limit, startingAfter: url.searchParams.get("starting_after") };
}

export function pageOf<T extends { id: string }>(
  rows: T[],
  startingAfter: string | null,
  limit: number,
): { data: T[]; hasMore: boolean } | null {
  let start = 0;
  if (startingAfter) {
    const i = rows.findIndex((r) => r.id === startingAfter);
    if (i < 0) return null;
    start = i + 1;
  }
  return { data: rows.slice(start, start + limit), hasMore: rows.length > start + limit };
}

export function tooManyResults(ctx: ApiAuthContext): NextResponse {
  return apiError(
    ctx,
    "invalid_request",
    "too_many_results",
    `More than ${MAX_SCAN} rows match. Narrow the request with more filters.`,
  );
}

export function listResponse<T>(
  ctx: ApiAuthContext,
  url: string,
  rows: T[],
  hasMore: boolean,
): NextResponse {
  return apiOk(ctx, { object: "list", data: rows, has_more: hasMore, url });
}

export function serializeTimeEntry(e: TimeEntry & { invoicedAt?: unknown; autoClosed?: boolean }) {
  return {
    id: e.id,
    object: "time_entry",
    job_id: e.jobId,
    visit_id: e.visitId,
    worker_id: e.workerId,
    hours_only: e.hoursOnly === true,
    duration_minutes: e.hoursOnly === true ? (e.durationMinutes ?? null) : null,
    date: e.hoursOnly === true ? ((e as { workDate?: string }).workDate ?? null) : null,
    start_at: e.hoursOnly === true ? null : tsToIso(e.startAt),
    end_at: e.hoursOnly === true ? null : tsToIso(e.endAt),
    running: e.running,
    billable: e.billable,
    voided: e.voided === true,
    source: e.source,
    invoiced: !!e.invoicedAt,
    auto_closed: e.autoClosed === true,
  };
}

export function serializeMaterial(m: MaterialLine) {
  return {
    id: m.id,
    object: "material",
    job_id: m.jobId,
    visit_id: m.visitId,
    worker_id: m.workerId,
    name: m.name,
    quantity: m.qty,
    unit: m.unit,
    unit_price: m.unitPriceMinor,
    unit_cost: m.unitCostMinor,
    taxable: m.taxable,
    billable: m.billable,
    not_in_estimate: m.notInEstimate,
    invoiced: !!m.invoiceLineId,
  };
}
