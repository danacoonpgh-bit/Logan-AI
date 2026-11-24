import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import { createAddOn, listAddOns } from "@/lib/server/field-addons-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    return NextResponse.json({ addOns: await listAddOns(subAccountId) });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = await readJson(request);
  if (!body) return badJson();
  try {
    const created = await createAddOn({ agencyId: guard.sub.agencyId, subAccountId, createdByUid: guard.access.uid, body });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
