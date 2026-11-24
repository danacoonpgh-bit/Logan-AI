import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import { setServiceAddOns } from "@/lib/server/field-addons-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string; serviceId: string }> }) {
  const { id: subAccountId, serviceId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = await readJson(request);
  if (!body) return badJson();
  const ids = Array.isArray(body.addOnIds) ? body.addOnIds.filter((x): x is string => typeof x === "string") : null;
  if (!ids) return badJson();
  try {
    await setServiceAddOns({ subAccountId, serviceId, addOnIds: ids });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
