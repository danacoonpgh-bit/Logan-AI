import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { updateInternalJob } from "@/lib/server/field-internal-jobs-service";
import { stopTimersForInternalJob } from "@/lib/server/field-time-service";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; internalJobId: string }> },
) {
  const { id: subAccountId, internalJobId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = await readJson(request);
  if (!body) return badJson();
  try {
    await updateInternalJob({ subAccountId, id: internalJobId, body });
    if (body.archived === true) {
      await stopTimersForInternalJob(subAccountId, internalJobId).catch(() => {});
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
