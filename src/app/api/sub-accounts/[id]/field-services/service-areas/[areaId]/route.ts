import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import {
  deleteServiceArea,
  updateServiceArea,
} from "@/lib/server/service-areas-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; areaId: string }> },
) {
  const { id: subAccountId, areaId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    await updateServiceArea({ subAccountId, areaId, body });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; areaId: string }> },
) {
  const { id: subAccountId, areaId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;

  try {
    await deleteServiceArea({ subAccountId, areaId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
