import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError } from "@/lib/api/responses";
import {
  MAX_SCAN,
  tooManyResults,
  fieldApiGate,
  listResponse,
  pageOf,
  pageParams,
} from "@/lib/api/field-services-api";
import { serializeVisit, tsToIso } from "@/lib/server/field-events";
import type { Visit } from "@/types/field-services";

export const GET = withApiAuth(async ({ request, ctx }) => {
  const denied = await fieldApiGate(ctx);
  if (denied) return denied;
  const { limit, startingAfter } = pageParams(request);
  if (ctx.mode !== "live") return listResponse(ctx, "/v1/visits", [], false);

  const url = new URL(request.url);
  let q: FirebaseFirestore.Query = getAdminDb()
    .collection("visits")
    .where("subAccountId", "==", ctx.subAccountId);
  const jobId = url.searchParams.get("job_id");
  const status = url.searchParams.get("status");
  const workerId = url.searchParams.get("worker_id");
  if (jobId) q = q.where("jobId", "==", jobId);
  if (status) q = q.where("status", "==", status);
  if (workerId) q = q.where("workerIds", "array-contains", workerId);

  const snap = await q.limit(MAX_SCAN + 1).get();
  if (snap.size > MAX_SCAN) return tooManyResults(ctx);
  const rows = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Visit)
    .sort((a, b) => String(tsToIso(a.scheduledStart)).localeCompare(String(tsToIso(b.scheduledStart))));
  const page = pageOf(rows, startingAfter, limit);
  if (!page) {
    return apiError(ctx, "invalid_request", "invalid_cursor", `starting_after=${startingAfter} not found.`);
  }
  return listResponse(ctx, "/v1/visits", page.data.map(serializeVisit), page.hasMore);
});
