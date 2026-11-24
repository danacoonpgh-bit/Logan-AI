import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { requireOffice } from "@/lib/field-services/route-helpers";
import { setWorkerDayStart } from "@/lib/server/field-workers-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

/** Sets, or with a null address clears, where one person's day starts on one date. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; workerId: string }> }) {
  const { id: subAccountId, workerId } = await params;
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
  try {
    await setWorkerDayStart({
      subAccountId,
      workerId,
      day: typeof body.day === "string" ? body.day : "",
      address: body.address ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
