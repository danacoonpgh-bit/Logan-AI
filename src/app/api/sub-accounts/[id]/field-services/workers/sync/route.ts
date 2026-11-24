import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { syncMemberWorkers } from "@/lib/server/field-workers-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

/** Makes sure every workspace member has a staff record. Safe to call as often as the page opens. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    return NextResponse.json(
      await syncMemberWorkers({ agencyId: guard.sub.agencyId, subAccountId, createdByUid: guard.access.uid }),
    );
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
