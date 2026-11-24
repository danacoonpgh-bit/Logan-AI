import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { FieldServicesError, fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { listIssuedDocuments } from "@/lib/server/field-documents-service";

export const dynamic = "force-dynamic";

/** The estimates and invoices made for one project. Office only. */
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
  try {
    return NextResponse.json(
      { documents: await listIssuedDocuments(subAccountId, jobId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
