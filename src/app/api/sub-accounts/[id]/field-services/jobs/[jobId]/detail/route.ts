import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { getJobDetail } from "@/lib/server/field-job-detail-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const res = NextResponse.json(await getJobDetail(subAccountId, jobId, ctx.actor.isOffice ? null : ctx.actor.workerId));
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
