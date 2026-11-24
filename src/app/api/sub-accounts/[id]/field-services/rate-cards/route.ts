import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import {
  createRateCard,
  listRateCards,
  requireTimesheetsOn,
} from "@/lib/server/field-rate-cards-service";
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
    await requireTimesheetsOn(subAccountId);
    return NextResponse.json({ cards: await listRateCards(subAccountId) });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = await readJson(request);
  if (!body) return badJson();
  try {
    const card = await createRateCard({
      agencyId: guard.sub.agencyId,
      subAccountId,
      createdByUid: guard.access.uid,
      body,
    });
    return NextResponse.json(card, { status: 201 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
