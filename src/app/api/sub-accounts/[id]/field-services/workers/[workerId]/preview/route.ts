import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { previewCrewDay } from "@/lib/server/field-crew-admin-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; workerId: string }> },
) {
  const { id: subAccountId, workerId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    return NextResponse.json(await previewCrewDay({ subAccountId, workerId }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
