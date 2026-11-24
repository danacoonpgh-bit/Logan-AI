import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { readJson } from "@/lib/field-services/route-helpers";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { addServiceMemberToFieldServices } from "@/lib/server/field-service-members-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const { id: subAccountId, memberId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = (await readJson(request)) ?? {};
  try {
    const result = await addServiceMemberToFieldServices({
      agencyId: guard.sub.agencyId,
      subAccountId,
      createdByUid: guard.access.uid,
      memberId,
      body,
    });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
