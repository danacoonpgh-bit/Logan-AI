import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { deleteJob, updateJob } from "@/lib/server/field-jobs-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.actor.isOffice) {
    return fieldServicesErrorResponse(
      new FieldServicesError("Only the office can do this.", 403),
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    await updateJob({ subAccountId, jobId, body });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId, { adminOnly: true });
  if (ctx instanceof NextResponse) return ctx;
  try {
    await deleteJob({ subAccountId, jobId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
