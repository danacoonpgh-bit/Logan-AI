import { NextResponse } from "next/server";
import { badJson, docContext, readJson } from "@/lib/field-services/route-helpers";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { deleteMaterial, updateMaterial } from "@/lib/server/field-materials-service";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  const { id: subAccountId, lineId } = await params;
  const ctx = await docContext(request, subAccountId, "materialLines", lineId);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(request);
  if (!body) return badJson();
  try {
    await updateMaterial({ subAccountId, lineId, actor: ctx.actor, body });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  const { id: subAccountId, lineId } = await params;
  const ctx = await docContext(request, subAccountId, "materialLines", lineId);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await deleteMaterial({ subAccountId, lineId, actor: ctx.actor });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
