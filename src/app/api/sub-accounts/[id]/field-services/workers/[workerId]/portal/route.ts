import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { resendPortalInvite, revokePortalLink, sendCrewAppLink } from "@/lib/server/field-portal-invite-service";
import { sendTestAlert } from "@/lib/server/field-crew-admin-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; workerId: string }> },
) {
  const { id: subAccountId, workerId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;

  let body: { action?: string };
  try {
    body = (await request.json()) as { action?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.action === "resend") {
      const result = await resendPortalInvite({
        subAccountId,
        workerId,
        createdByUid: guard.access.uid,
      });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "send_link") {
      const result = await sendCrewAppLink({ subAccountId, workerId });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "test_push") {
      const delivered = await sendTestAlert({ subAccountId, workerId });
      return NextResponse.json({ delivered });
    }
    if (body.action === "revoke") {
      await revokePortalLink({ subAccountId, workerId });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
