import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { requestSignoff } from "@/lib/server/field-signoff-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; visitId: string }> },
) {
  const { id: subAccountId, visitId } = await params;
  const ctx = await docContext(request, subAccountId, "visits", visitId);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const res = await requestSignoff({
      subAccountId,
      visitId,
      actor: { isOffice: ctx.actor.isOffice, workerId: ctx.actor.workerId, uid: ctx.actor.uid },
    });
    return NextResponse.json(res);
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
