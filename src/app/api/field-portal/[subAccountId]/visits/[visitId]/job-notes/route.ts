import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { getAdminDb } from "@/lib/firebase/admin";
import { crewActionAllowed, portalAccess } from "@/lib/server/field-portal-access";
import { changeJobNote } from "@/lib/server/field-job-notes-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export const POST = withFieldPerson<{ subAccountId: string; visitId: string }>(
  async ({ request, session, params }) => {
    const access = await portalAccess({ session }, params.subAccountId, "visits", params.visitId);
    if (access instanceof Response) return access;
    if (!(await crewActionAllowed(session.personId, params.visitId))) {
      return json({ error: "Too many updates. Wait a few minutes." }, 429);
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);
    if (body.action !== "add" && body.action !== "edit" && body.action !== "delete") {
      return json({ error: "Unknown action." }, 400);
    }
    const visit = (await getAdminDb().doc(`visits/${params.visitId}`).get()).data();
    if (!visit?.jobId) return json({ error: "Not found." }, 404);
    try {
      await changeJobNote({
        subAccountId: params.subAccountId,
        jobId: visit.jobId as string,
        actor: access.actor,
        action: body.action,
        noteId: typeof body.noteId === "string" ? body.noteId : undefined,
        text: body.text,
      });
      return json({ ok: true });
    } catch (err) {
      return fieldServicesErrorResponse(err);
    }
  },
);
