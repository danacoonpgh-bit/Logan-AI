import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import { listChecklistTemplates, saveChecklistTemplate } from "@/lib/server/field-checklists-service";
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
      { templates: await listChecklistTemplates(subAccountId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = await readJson(request);
  if (!body) return badJson();
  try {
    const template = await saveChecklistTemplate({
      agencyId: guard.sub.agencyId,
      subAccountId,
      productId: body.productId,
      items: body.items,
      requireChecklist: body.requireChecklist,
      requireSignature: body.requireSignature,
    });
    return NextResponse.json({ template });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
