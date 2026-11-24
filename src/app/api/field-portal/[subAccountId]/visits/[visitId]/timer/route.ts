import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { crewActionAllowed, portalAccess } from "@/lib/server/field-portal-access";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { startTimer, stopTimer } from "@/lib/server/field-time-service";

export const dynamic = "force-dynamic";

export const POST = withFieldPerson<{ subAccountId: string; visitId: string }>(
  async ({ request, session, params }) => {
    const access = await portalAccess({ session }, params.subAccountId, "visits", params.visitId);
    if (access instanceof Response) return access;
    if (!(await crewActionAllowed(session.personId, params.visitId))) {
      return json({ error: "Too many updates. Wait a few minutes." }, 429);
    }
    const body = (await request.json().catch(() => null)) as
      | { action?: unknown; entryId?: unknown }
      | null;
    try {
      if (body?.action === "start") {
        const res = await startTimer({
          subAccountId: params.subAccountId,
          visitId: params.visitId,
          actor: access.actor,
        });
        return json(res, 201);
      }
      if (body?.action === "stop" && typeof body.entryId === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(body.entryId)) {
        await stopTimer({
          subAccountId: params.subAccountId,
          entryId: body.entryId,
          visitId: params.visitId,
          actor: access.actor,
        });
        return json({ ok: true });
      }
      return json({ error: "Unknown action" }, 400);
    } catch (err) {
      return fieldServicesErrorResponse(err);
    }
  },
);
