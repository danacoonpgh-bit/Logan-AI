import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { requireOffice } from "@/lib/field-services/route-helpers";
import { requireTerritoryOfDoc } from "@/lib/field-services/territory";
import { createJobFromRequest } from "@/lib/server/field-jobs-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(
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

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
  }

  try {
    const job = await createJobFromRequest({
      agencyId: guard.sub.agencyId,
      subAccountId,
      createdByUid: guard.access.uid,
      requestId,
      lineItems: body.lineItems,
      currency: body.currency,
    });
    return NextResponse.json(job, { status: 201 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
