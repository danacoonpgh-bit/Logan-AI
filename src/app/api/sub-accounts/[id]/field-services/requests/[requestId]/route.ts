import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { requireOffice } from "@/lib/field-services/route-helpers";
import { requireTerritoryOfDoc } from "@/lib/field-services/territory";
import { deleteServiceRequest, updateServiceRequest } from "@/lib/server/field-requests-service";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  const { id: subAccountId, requestId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const notOffice = await requireOffice(guard);
  if (notOffice) return notOffice;
  const outOfScope = await requireTerritoryOfDoc(guard, "serviceRequests", requestId);
  if (outOfScope) return outOfScope;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    await updateServiceRequest({ subAccountId, requestId, body });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  const { id: subAccountId, requestId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const outOfScope = await requireTerritoryOfDoc(guard, "serviceRequests", requestId);
  if (outOfScope) return outOfScope;
  try {
    await deleteServiceRequest({ subAccountId, requestId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
