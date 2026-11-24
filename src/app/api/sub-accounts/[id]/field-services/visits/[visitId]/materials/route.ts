import { NextResponse } from "next/server";
import { badJson, docContext, readJson } from "@/lib/field-services/route-helpers";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { addMaterial } from "@/lib/server/field-materials-service";

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
    const res = await addMaterial({ subAccountId, visitId, actor: ctx.actor, body });
    return NextResponse.json(res, { status: 201 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
