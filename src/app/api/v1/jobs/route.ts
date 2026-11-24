import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError } from "@/lib/api/responses";
import { fieldApiGate, listResponse, pageParams } from "@/lib/api/field-services-api";
import { serializeJob } from "@/lib/server/field-events";
import type { Job } from "@/types/field-services";

/** GET /v1/jobs?status=|contact_id=&limit=&starting_after= (newest first). Use one filter at a time. */
export const GET = withApiAuth(async ({ request, ctx }) => {
  const denied = await fieldApiGate(ctx);
  if (denied) return denied;
  const { limit, startingAfter } = pageParams(request);
  if (ctx.mode !== "live") return listResponse(ctx, "/v1/jobs", [], false);

  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  const contactId = params.get("contact_id");
  if (status && contactId) {
    return apiError(ctx, "invalid_request", "too_many_filters", "Use either status or contact_id, not both.");
  }

  const db = getAdminDb();
  let q: FirebaseFirestore.Query = db
    .collection("jobs")
    .where("subAccountId", "==", ctx.subAccountId);
  if (status) q = q.where("status", "==", status);
  if (contactId) q = q.where("contactId", "==", contactId);
  q = q.orderBy("createdAt", "desc");

  if (startingAfter) {
    const cursor = await db.doc(`jobs/${startingAfter}`).get();
    if (!cursor.exists || cursor.data()?.subAccountId !== ctx.subAccountId) {
      return apiError(ctx, "invalid_request", "invalid_cursor", `starting_after=${startingAfter} not found.`);
    }
    q = q.startAfter(cursor.data()!.createdAt);
  }

  const snap = await q.limit(limit + 1).get();
  const rows = snap.docs.slice(0, limit).map((d) => serializeJob({ id: d.id, ...d.data() } as Job));
  return listResponse(ctx, "/v1/jobs", rows, snap.docs.length > limit);
});
