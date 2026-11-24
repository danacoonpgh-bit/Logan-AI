import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { requireTerritoryOfDoc } from "@/lib/field-services/territory";
import { resolveActor } from "@/lib/server/field-access";
import { actorIsOffice, setVisitStatus } from "@/lib/server/field-visits-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; visitId: string }> },
) {
  const { id: subAccountId, visitId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const actor = await resolveActor(subAccountId, guard.access.uid, guard.access.subAccountRole);
  const outOfScope = await requireTerritoryOfDoc(guard, "visits", visitId, actor.workerId);
  if (outOfScope) return outOfScope;

  let body: { status?: string };
  try {
    body = (await request.json()) as { status?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const isOffice = await actorIsOffice(
      subAccountId,
      guard.access.uid,
      guard.access.subAccountRole,
    );
    await setVisitStatus({
      subAccountId,
      visitId,
      status: body.status ?? "",
      actorUid: guard.access.uid,
      isOffice,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
