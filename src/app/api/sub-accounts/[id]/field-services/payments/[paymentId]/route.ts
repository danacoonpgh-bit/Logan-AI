import { NextResponse } from "next/server";
import { badJson, docContext, readJson } from "@/lib/field-services/route-helpers";
import {
  FieldServicesError,
  fieldServicesErrorResponse,
} from "@/lib/server/field-services-errors";
import { decidePayment } from "@/lib/server/field-payments-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; paymentId: string }> },
) {
  const { id: subAccountId, paymentId } = await params;
  const ctx = await docContext(request, subAccountId, "jobPayments", paymentId);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(request);
  if (!body) return badJson();

  try {
    if (!ctx.actor.isOffice) {
      throw new FieldServicesError("Only the office can confirm a payment.", 403);
    }
    if (body.decision !== "confirm" && body.decision !== "reject") {
      throw new FieldServicesError("Choose confirm or reject.");
    }
    const res = await decidePayment({
      subAccountId,
      paymentId,
      actorUid: ctx.actor.uid,
      decision: body.decision,
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
