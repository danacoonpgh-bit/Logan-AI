import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { portalAccess } from "@/lib/server/field-portal-access";
import { deleteMaterial } from "@/lib/server/field-materials-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export const DELETE = withFieldPerson<{ subAccountId: string; lineId: string }>(
  async ({ session, params }) => {
    const access = await portalAccess({ session }, params.subAccountId, "materialLines", params.lineId);
    if (access instanceof Response) return access;
    try {
      await deleteMaterial({
        subAccountId: params.subAccountId,
        lineId: params.lineId,
        actor: access.actor,
      });
      return json({ ok: true });
    } catch (err) {
      return fieldServicesErrorResponse(err);
    }
  },
);
