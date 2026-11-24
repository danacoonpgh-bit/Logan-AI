import { NextResponse } from "next/server";
import { requireFieldServicesAdmin, requireFieldServicesMember } from "@/lib/field-services/gate";
import {
  getFieldServicesConfig,
  updateFieldServicesConfig,
} from "@/lib/server/field-services-config-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json({ config: await getFieldServicesConfig(subAccountId) });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    return NextResponse.json({
      config: await updateFieldServicesConfig(subAccountId, body),
    });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
