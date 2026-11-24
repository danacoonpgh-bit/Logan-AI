import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { getCustomerLink, revokeCustomerLink } from "@/lib/server/field-approvals-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function GET(
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
    return NextResponse.json(
      { url: await getCustomerLink(subAccountId, jobId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId, { adminOnly: true });
  if (ctx instanceof NextResponse) return ctx;
  try {
    await revokeCustomerLink(subAccountId, jobId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
