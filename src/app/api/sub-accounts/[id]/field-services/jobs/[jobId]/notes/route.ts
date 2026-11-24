import { NextResponse } from "next/server";
import { badJson, docContext, readJson } from "@/lib/field-services/route-helpers";
import { getAdminDb } from "@/lib/firebase/admin";
import { changeJobNote } from "@/lib/server/field-job-notes-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.actor.isOffice) {
    const mine = ctx.actor.workerId
      ? await getAdminDb()
          .collection("visits")
          .where("jobId", "==", jobId)
          .where("workerIds", "array-contains", ctx.actor.workerId)
          .limit(1)
          .get()
      : null;
    if (!mine || mine.empty || mine.docs[0].data().subAccountId !== subAccountId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
  }
  const body = await readJson(request);
  if (!body) return badJson();
  if (body.action !== "add" && body.action !== "edit" && body.action !== "delete") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  try {
    await changeJobNote({
      subAccountId,
      jobId,
      actor: ctx.actor,
      action: body.action,
      noteId: typeof body.noteId === "string" ? body.noteId : undefined,
      text: body.text,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
