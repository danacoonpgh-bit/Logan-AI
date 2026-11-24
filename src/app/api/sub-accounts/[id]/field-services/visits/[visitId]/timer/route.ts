import { NextResponse } from "next/server";
import { badJson, docContext, readJson } from "@/lib/field-services/route-helpers";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { startTimer, stopTimer } from "@/lib/server/field-time-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; visitId: string }> },
) {
  const { id: subAccountId, visitId } = await params;
  const ctx = await docContext(request, subAccountId, "visits", visitId);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(request);
  if (!body) return badJson();

  try {
    if (body.action === "start") {
      const res = await startTimer({
        subAccountId,
        visitId,
        actor: ctx.actor,
        workerId: typeof body.workerId === "string" ? body.workerId : undefined,
      });
      return NextResponse.json(res, { status: 201 });
    }
    if (body.action === "stop" && typeof body.entryId === "string") {
      await stopTimer({ subAccountId, entryId: body.entryId, visitId, actor: ctx.actor });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
