import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { createDocumentFromJob } from "@/lib/server/field-documents-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  const guard = ctx.guard;
  if (!ctx.actor.isOffice) {
    return fieldServicesErrorResponse(
      new FieldServicesError("Only the office can do this.", 403),
    );
  }

  let body: {
    kind?: string;
    preview?: boolean;
    includeTravelFee?: boolean;
    visitId?: string;
    weekEnding?: string;
    weeks?: number | null;
  };
  try {
    body = (await request.json()) as {
      kind?: string;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.kind !== "quote" && body.kind !== "invoice") {
    return NextResponse.json({ error: "kind must be quote or invoice" }, { status: 400 });
  }

  try {
    const doc = await createDocumentFromJob({
      subAccountId,
      jobId,
      kind: body.kind,
      preview: body.preview === true,
      createdByUid: guard.access.uid,
      options: {
        includeTravelFee: body.includeTravelFee === true,
        weekEnding: typeof body.weekEnding === "string" ? body.weekEnding : undefined,
        weeks: typeof body.weeks === "number" ? body.weeks : null,
        includeLabour: true,
        includeParts: true,
        visitId: typeof body.visitId === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(body.visitId) ? body.visitId : undefined,
      },
    });
    return NextResponse.json(doc, { status: body.preview === true ? 200 : 201 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
