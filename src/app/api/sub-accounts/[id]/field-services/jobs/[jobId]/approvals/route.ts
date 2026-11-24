import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { createApproval, listApprovals } from "@/lib/server/field-approvals-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

const OFFICE_ONLY = NextResponse.json({ error: "Only the office can do this." }, { status: 403 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.actor.isOffice) return OFFICE_ONLY.clone();
  return NextResponse.json(
    { approvals: await listApprovals(subAccountId, jobId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.actor.isOffice) return OFFICE_ONLY.clone();
  const body = (await request.json().catch(() => null)) as { lines?: unknown; note?: unknown } | null;
  try {
    const res = await createApproval({
      subAccountId,
      jobId,
      createdByUid: ctx.guard.access.uid,
      lines: body?.lines,
      note: body?.note,
    });
    return NextResponse.json(res, { status: 201 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
