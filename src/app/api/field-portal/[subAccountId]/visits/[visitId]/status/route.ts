import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { portalAccess } from "@/lib/server/field-portal-access";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { setVisitStatus } from "@/lib/server/field-visits-service";

export const dynamic = "force-dynamic";

export const POST = withFieldPerson<{ subAccountId: string; visitId: string }>(
  async ({ request, session, params }) => {
    const access = await portalAccess({ session }, params.subAccountId, "visits", params.visitId);
    if (access instanceof Response) return access;
    const body = (await request.json().catch(() => null)) as { status?: unknown } | null;
    try {
      await setVisitStatus({
        subAccountId: params.subAccountId,
        visitId: params.visitId,
        status: typeof body?.status === "string" ? body.status : "",
        actorUid: access.actor.uid,
        isOffice: false,
        workerId: access.actor.workerId,
      });
      return json({ ok: true });
    } catch (err) {
      return fieldServicesErrorResponse(err);
    }
  },
);
