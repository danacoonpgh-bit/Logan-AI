import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { requireTerritoryOfDoc } from "@/lib/field-services/territory";
import { resolveActor } from "@/lib/server/field-access";
import { actorIsOffice, updateVisit } from "@/lib/server/field-visits-service";
import {
  FieldServicesError,
  fieldServicesErrorResponse,
} from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; visitId: string }> },
) {
  const { id: subAccountId, visitId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const actor = await resolveActor(subAccountId, guard.access.uid, guard.access.subAccountRole);
  const outOfScope = await requireTerritoryOfDoc(guard, "visits", visitId, actor.workerId);
  if (outOfScope) return outOfScope;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const office = await actorIsOffice(
      subAccountId,
      guard.access.uid,
      guard.access.subAccountRole,
    );
    if (!office) {
      throw new FieldServicesError("Only the office can change the schedule.", 403);
    }
    const res = await updateVisit({ subAccountId, visitId, body });
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
