import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { refreshJobCustomerName } from "@/lib/server/field-jobs-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

/** Brings the customer name copied onto a project (and its visits) back in line with the contact. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.actor.isOffice) {
    return NextResponse.json({ error: "Only the office can do this." }, { status: 403 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await refreshJobCustomerName({ subAccountId, jobId })) });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
