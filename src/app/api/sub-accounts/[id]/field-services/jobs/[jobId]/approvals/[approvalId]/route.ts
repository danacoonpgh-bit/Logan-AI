import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { cancelApproval } from "@/lib/server/field-approvals-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string; approvalId: string }> },
) {
  const { id: subAccountId, jobId, approvalId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.actor.isOffice) {
    return NextResponse.json({ error: "Only the office can do this." }, { status: 403 });
  }
  try {
    await cancelApproval({ subAccountId, jobId, approvalId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
