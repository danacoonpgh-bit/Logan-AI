import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { crewActionAllowed, portalAccess } from "@/lib/server/field-portal-access";
import { addMaterial } from "@/lib/server/field-materials-service";
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
    const safe = access.link.canHandlePrices
      ? body
      : { ...body, unitPriceMinor: 0, unitCostMinor: 0 };
    try {
      const res = await addMaterial({
        subAccountId: params.subAccountId,
        visitId: params.visitId,
        actor: access.actor,
        body: safe,
      });
      return json(res, 201);
    } catch (err) {
      return fieldServicesErrorResponse(err);
    }
  },
);
