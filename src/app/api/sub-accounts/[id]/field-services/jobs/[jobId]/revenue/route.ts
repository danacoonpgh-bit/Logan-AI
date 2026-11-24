import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { FieldServicesError, fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { jobRevenue } from "@/lib/server/field-revenue-service";

export const dynamic = "force-dynamic";

/** What the project has earned so far. Office only. `?wip=1` leaves out what is already on an invoice. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.actor.isOffice) {
    return fieldServicesErrorResponse(new FieldServicesError("Only the office can do this.", 403));
  }
  const wip = new URL(request.url).searchParams.get("wip") === "1";
  try {
    return NextResponse.json(await jobRevenue({ subAccountId, jobId, wip }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
