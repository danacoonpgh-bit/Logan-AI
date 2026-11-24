import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { crewActionAllowed, portalAccess } from "@/lib/server/field-portal-access";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { requestTimeCorrection } from "@/lib/server/field-time-service";

export const dynamic = "force-dynamic";

export const POST = withFieldPerson<{ subAccountId: string; entryId: string }>(
  async ({ request, session, params }) => {
    const access = await portalAccess({ session }, params.subAccountId, "timeEntries", params.entryId);
    if (access instanceof Response) return access;
    if (!(await crewActionAllowed(session.personId, params.entryId))) {
      return json({ error: "Too many updates. Wait a few minutes." }, 429);
    }
    const body = (await request.json().catch(() => null)) as { note?: unknown } | null;
    try {
      await requestTimeCorrection({
        subAccountId: params.subAccountId,
        entryId: params.entryId,
        actor: access.actor,
        note: typeof body?.note === "string" ? body.note : "",
      });
      return json({ ok: true });
    } catch (err) {
      return fieldServicesErrorResponse(err);
    }
  },
);
