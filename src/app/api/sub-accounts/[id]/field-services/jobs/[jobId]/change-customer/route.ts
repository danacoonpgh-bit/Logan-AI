import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { changeJobCustomer } from "@/lib/server/field-jobs-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

/** Moves a project to another customer (admin only), for when the wrong contact was picked. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId, { adminOnly: true });
  if (ctx instanceof NextResponse) return ctx;
  let body: { contactId?: unknown };
  try {
    body = (await request.json()) as { contactId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const res = await changeJobCustomer({
      subAccountId,
      jobId,
      contactId: typeof body.contactId === "string" ? body.contactId : "",
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
