import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { createVisit } from "@/lib/server/field-visits-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  const guard = ctx.guard;
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
    const res = await createVisit({
      agencyId: guard.sub.agencyId,
      subAccountId,
      createdByUid: guard.access.uid,
      jobId,
      scheduledStart: body.scheduledStart,
      scheduledEnd: body.scheduledEnd,
      durationMinutes: body.durationMinutes,
      anytime: body.anytime,
      workerIds: body.workerIds,
      notes: body.notes,
    });
    return NextResponse.json(res, { status: 201 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
