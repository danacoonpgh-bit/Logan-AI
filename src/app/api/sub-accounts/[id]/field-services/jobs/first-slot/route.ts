import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { requireOffice } from "@/lib/field-services/route-helpers";
import { suggestFirstSlot } from "@/lib/server/field-first-slot";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

/** The earliest open time for the chosen staff, to pre-fill the first visit of a new fixed price project. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const notOffice = await requireOffice(guard);
  if (notOffice) return notOffice;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const ids = Array.isArray(body.workerIds) ? body.workerIds.filter((x): x is string => typeof x === "string") : [];
  const minutes = typeof body.minutes === "number" ? body.minutes : 60;
  const travel = typeof body.travelMinutes === "number" ? body.travelMinutes : 0;
  try {
    return NextResponse.json(await suggestFirstSlot(subAccountId, ids, minutes, travel));
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
