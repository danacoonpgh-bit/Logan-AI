import { NextResponse } from "next/server";
import { badJson, docContext, readJson } from "@/lib/field-services/route-helpers";
import {
  FieldServicesError,
  fieldServicesErrorResponse,
} from "@/lib/server/field-services-errors";
import { addManualTimeEntry } from "@/lib/server/field-time-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; visitId: string }> },
) {
  const { id: subAccountId, visitId } = await params;
  const ctx = await docContext(request, subAccountId, "visits", visitId);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(request);
  if (!body) return badJson();

  try {
    if (!ctx.actor.isOffice) {
      throw new FieldServicesError("Only the office can add time.", 403);
    }
    const res = await addManualTimeEntry({
      subAccountId,
      visitId,
      workerId: typeof body.workerId === "string" ? body.workerId : "",
      startAt: body.startAt,
      endAt: body.endAt,
      actorUid: ctx.actor.uid,
      reason: typeof body.reason === "string" ? body.reason : "",
      note: typeof body.note === "string" ? body.note : "",
    });
    return NextResponse.json(res, { status: 201 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
