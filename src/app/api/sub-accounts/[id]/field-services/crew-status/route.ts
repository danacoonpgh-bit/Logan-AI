import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { crewAppStatus } from "@/lib/server/field-crew-status-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    return NextResponse.json(
      { status: await crewAppStatus(subAccountId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
