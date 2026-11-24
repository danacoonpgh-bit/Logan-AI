import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import { FieldServicesError, fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { VISIT_MESSAGE_KINDS, cleanVisitMessageSetting, type VisitMessageKind } from "@/lib/field-services/visit-messages";

export const dynamic = "force-dynamic";

/** Body { kind, enabled?, setting? }: changes one customer message of one service. Admin only. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; productId: string }> }) {
  const { id: subAccountId, productId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = await readJson(request);
  if (!body) return badJson();
  try {
    const kind = body.kind as VisitMessageKind;
    if (!VISIT_MESSAGE_KINDS.includes(kind)) throw new FieldServicesError("Choose which message.");
    const ref = getAdminDb().doc(`products/${productId}`);
    const snap = await ref.get();
    const product = snap.data();
    if (!snap.exists || product?.subAccountId !== subAccountId || product?.kind !== "service") {
      throw new FieldServicesError("Service not found.", 404);
    }
    const existing = ((product.customerMessages ?? {}) as Record<string, Record<string, unknown>>)[kind] ?? {};
    let next: Record<string, unknown> = { ...existing };
    if (body.setting !== undefined) {
      const clean = cleanVisitMessageSetting(body.setting);
      if (typeof clean === "string") throw new FieldServicesError(clean);
      next = { ...next, ...clean };
    }
    if (typeof body.enabled === "boolean") next.enabled = body.enabled;
    next.enabled = next.enabled === true;
    await ref.update({ [`customerMessages.${kind}`]: next, updatedAt: FieldValue.serverTimestamp() });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
