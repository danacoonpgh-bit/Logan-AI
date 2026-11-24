import { cookies } from "next/headers";
import { json, sameOrigin } from "@/lib/field-portal/guard";
import { clearCustomerCookieHeader, customerCookieName, endCustomerSession } from "@/lib/server/field-customer-auth-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ subAccountId: string }> }) {
  if (!sameOrigin(request)) return json({ error: "Not allowed." }, 403);
  const { subAccountId } = await params;
  const jar = await cookies();
  await endCustomerSession(jar.get(customerCookieName(subAccountId))?.value);
  return json({ ok: true }, 200, clearCustomerCookieHeader(subAccountId));
}
