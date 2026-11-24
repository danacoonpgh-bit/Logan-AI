import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { startRecurrence, stopRecurrence, updateRecurrence } from "@/lib/server/field-recurrence-service";

export const dynamic = "force-dynamic";

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
  const body = (await request.json().catch(() => null)) as { action?: unknown; schedule?: unknown } | null;
  try {
    if (body?.action === "start") {
      return NextResponse.json(await startRecurrence({ subAccountId, jobId, body: body.schedule }), { status: 201 });
    }
    if (body?.action === "update") {
      return NextResponse.json(await updateRecurrence({ subAccountId, jobId, body: body.schedule }));
    }
    if (body?.action === "stop") {
      return NextResponse.json(await stopRecurrence({ subAccountId, jobId }));
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
