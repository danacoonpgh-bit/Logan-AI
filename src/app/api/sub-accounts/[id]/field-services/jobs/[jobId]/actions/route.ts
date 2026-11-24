import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { requireTerritoryOfDoc } from "@/lib/field-services/territory";
import { cancelJob, closeJob, reopenJob } from "@/lib/server/field-jobs-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const outOfScope = await requireTerritoryOfDoc(guard, "jobs", jobId);
  if (outOfScope) return outOfScope;

  let body: { action?: string };
  try {
    body = (await request.json()) as { action?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.action === "close") await closeJob({ subAccountId, jobId });
    else if (body.action === "reopen") await reopenJob({ subAccountId, jobId });
    else if (body.action === "cancel") await cancelJob({ subAccountId, jobId });
    else return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
