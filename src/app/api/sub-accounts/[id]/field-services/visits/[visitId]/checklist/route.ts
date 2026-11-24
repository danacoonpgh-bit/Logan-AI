import { NextResponse } from "next/server";
import { badJson, docContext, readJson } from "@/lib/field-services/route-helpers";
import { refreshVisitChecklist, updateVisitChecklist } from "@/lib/server/field-checklists-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

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
    if (body.action === "refresh") {
      if (!ctx.actor.isOffice) {
        return NextResponse.json({ error: "Only the office can do this." }, { status: 403 });
      }
      return NextResponse.json(await refreshVisitChecklist({ subAccountId, visitId }));
    }
    return NextResponse.json(
      await updateVisitChecklist({ subAccountId, visitId, actor: ctx.actor, body }),
    );
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
