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
  serializeMaterial,
} from "@/lib/api/field-services-api";
import type { MaterialLine } from "@/types/field-services";

export const GET = withApiAuth(async ({ request, ctx }) => {
  const denied = await fieldApiGate(ctx);
  if (denied) return denied;
  const { limit, startingAfter } = pageParams(request);
  const url = new URL(request.url);
  const jobId = url.searchParams.get("job_id");
  const visitId = url.searchParams.get("visit_id");
  if (!jobId && !visitId) {
    return apiError(ctx, "invalid_request", "missing_filter", "Pass job_id or visit_id.");
  }
  if (ctx.mode !== "live") return listResponse(ctx, "/v1/materials", [], false);

  let q: FirebaseFirestore.Query = getAdminDb()
    .collection("materialLines")
    .where("subAccountId", "==", ctx.subAccountId);
  q = jobId ? q.where("jobId", "==", jobId) : q.where("visitId", "==", visitId);

  const snap = await q.limit(MAX_SCAN + 1).get();
  if (snap.size > MAX_SCAN) return tooManyResults(ctx);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MaterialLine);
  const page = pageOf(rows, startingAfter, limit);
  if (!page) {
    return apiError(ctx, "invalid_request", "invalid_cursor", `starting_after=${startingAfter} not found.`);
  }
  return listResponse(ctx, "/v1/materials", page.data.map(serializeMaterial), page.hasMore);
});
