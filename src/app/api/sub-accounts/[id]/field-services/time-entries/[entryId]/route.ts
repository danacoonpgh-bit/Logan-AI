import { NextResponse } from "next/server";
import { badJson, docContext, readJson } from "@/lib/field-services/route-helpers";
import {
  FieldServicesError,
  fieldServicesErrorResponse,
} from "@/lib/server/field-services-errors";
import { editTimeEntry, requestTimeCorrection } from "@/lib/server/field-time-service";
import { requireTerritoryOfDoc } from "@/lib/field-services/territory";
import { parseTarget } from "@/lib/server/field-crew-time-service";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id: subAccountId, entryId } = await params;
  const ctx = await docContext(request, subAccountId, "timeEntries", entryId);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(request);
  if (!body) return badJson();

  try {
    if (!ctx.actor.isOffice) {
      throw new FieldServicesError("Only the office can edit time.", 403);
    }
    const target = body.target ? parseTarget(body.target) : undefined;
    if (target?.type === "job") {
      const outOfScope = await requireTerritoryOfDoc(ctx.guard, "jobs", target.jobId);
      if (outOfScope) return outOfScope;
    }
    await editTimeEntry({
      subAccountId,
      entryId,
      actorUid: ctx.actor.uid,
      reason: typeof body.reason === "string" ? body.reason : "",
      body: { ...body, target },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id: subAccountId, entryId } = await params;
  const ctx = await docContext(request, subAccountId, "timeEntries", entryId);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(request);
  if (!body) return badJson();

  try {
    await requestTimeCorrection({
      subAccountId,
      entryId,
      actor: ctx.actor,
      note: typeof body.note === "string" ? body.note : "",
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
