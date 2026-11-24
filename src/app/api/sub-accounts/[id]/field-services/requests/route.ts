import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { requireOffice } from "@/lib/field-services/route-helpers";
import { requireTerritoryOfContact } from "@/lib/field-services/territory";
import { createServiceRequest } from "@/lib/server/field-requests-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.contactId !== "string" || !body.contactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }
  const notOffice = await requireOffice(guard);
  if (notOffice) return notOffice;
  const outOfScope = await requireTerritoryOfContact(guard, body.contactId);
  if (outOfScope) return outOfScope;

  try {
    const res = await createServiceRequest({
      agencyId: guard.sub.agencyId,
      subAccountId,
      createdByUid: guard.access.uid,
      contactId: body.contactId,
      title: typeof body.title === "string" ? body.title : "",
      description: typeof body.description === "string" ? body.description : "",
      serviceAddress: body.serviceAddress,
      serviceIds: body.serviceIds,
      source: "manual",
    });
    return NextResponse.json(res, { status: 201 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
