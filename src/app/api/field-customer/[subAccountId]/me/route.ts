import { cookies } from "next/headers";
import { json } from "@/lib/field-portal/guard";
import {
  customerCookieName,
  readCustomerSession,
  requirePortalOpen,
} from "@/lib/server/field-customer-auth-service";
import { loadCustomerHome } from "@/lib/server/field-customer-portal-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ subAccountId: string }> }) {
  const { subAccountId } = await params;
  try {
    await requirePortalOpen(subAccountId);
    const jar = await cookies();
    const session = await readCustomerSession(jar.get(customerCookieName(subAccountId))?.value, subAccountId);
    if (!session) return json({ error: "Sign in to continue." }, 401);
    const home = await loadCustomerHome(subAccountId, session.contactId);
    if (!home) return json({ error: "Sign in to continue." }, 401);
    return json(home);
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
