import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import { fieldApiGate } from "@/lib/api/field-services-api";
import { serializeJob } from "@/lib/server/field-events";
import type { Job } from "@/types/field-services";

export const GET = withApiAuth<{ id: string }>(async ({ params, ctx }) => {
  const denied = await fieldApiGate(ctx);
  if (denied) return denied;
  const snap = ctx.mode === "live" ? await getAdminDb().doc(`jobs/${params.id}`).get() : null;
  const data = snap?.data();
  if (!snap || !data || data.subAccountId !== ctx.subAccountId) {
    return apiError(ctx, "not_found", "job_not_found", "Job not found.");
  }
  return apiOk(ctx, { job: serializeJob({ id: snap.id, ...data } as Job) });
});
