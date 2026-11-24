import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import { updateRateCard } from "@/lib/server/field-rate-cards-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; cardId: string }> },
) {
  const { id: subAccountId, cardId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = await readJson(request);
  if (!body) return badJson();
  try {
    await updateRateCard({ subAccountId, cardId, body });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
