import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { crewActionAllowed, portalAccess } from "@/lib/server/field-portal-access";
import { requestSignoff } from "@/lib/server/field-signoff-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export const POST = withFieldPerson<{ subAccountId: string; visitId: string }>(
  async ({ session, params }) => {
    const access = await portalAccess({ session }, params.subAccountId, "visits", params.visitId);
    if (access instanceof Response) return access;
    if (!(await crewActionAllowed(session.personId, params.visitId))) {
      return json({ error: "Too many updates. Wait a few minutes." }, 429);
    }
    try {
      return json(
        await requestSignoff({
          subAccountId: params.subAccountId,
          visitId: params.visitId,
          actor: access.actor,
        }),
      );
    } catch (err) {
      return fieldServicesErrorResponse(err);
    }
  },
);
