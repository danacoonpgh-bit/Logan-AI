import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import { fieldApiGate } from "@/lib/api/field-services-api";
import { serializeVisit } from "@/lib/server/field-events";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { setVisitStatus } from "@/lib/server/field-visits-service";
import type { Visit } from "@/types/field-services";

async function loadVisit(id: string, subAccountId: string, live: boolean) {
  if (!live) return null;
  const snap = await getAdminDb().doc(`visits/${id}`).get();
  const data = snap.data();
  return snap.exists && data?.subAccountId === subAccountId
    ? ({ id: snap.id, ...data } as Visit)
    : null;
}

export const GET = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const denied = await fieldApiGate(ctx);
  if (denied) return denied;
  const visit = await loadVisit(params.id, ctx.subAccountId, ctx.mode === "live");
  if (!visit) return apiError(ctx, "not_found", "visit_not_found", "Visit not found.");
  return apiOk(ctx, { visit: serializeVisit(visit) });
});

export const PATCH = withApiAuth<{ id: string }>(async ({ body, params, ctx }) => {
  const denied = await fieldApiGate(ctx);
  if (denied) return denied;
  const status = (body as { status?: unknown } | null)?.status;
  if (typeof status !== "string") {
    return apiError(ctx, "invalid_request", "invalid_body", "status is required.");
  }
  const existing = await loadVisit(params.id, ctx.subAccountId, ctx.mode === "live");
  if (!existing) return apiError(ctx, "not_found", "visit_not_found", "Visit not found.");
  try {
    await setVisitStatus({
      subAccountId: ctx.subAccountId,
      visitId: params.id,
      status,
      actorUid: `apikey:${ctx.keyPrefix}`,
      isOffice: true,
    });
  } catch (err) {
    if (err instanceof FieldServicesError) {
      return apiError(
        ctx,
        err.status === 404 ? "not_found" : "invalid_request",
        "visit_status_rejected",
        err.message,
      );
    }
    throw err;
  }
  const fresh = await loadVisit(params.id, ctx.subAccountId, true);
  return apiOk(ctx, { visit: serializeVisit(fresh ?? existing) });
});
