import { json, portalClientIp, sameOrigin } from "@/lib/field-portal/guard";
import {
  customerCookieHeader,
  parseIdentity,
  requirePortalOpen,
  verifyCustomerCode,
} from "@/lib/server/field-customer-auth-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ subAccountId: string }> }) {
  if (!sameOrigin(request)) return json({ error: "Not allowed." }, 403);
  const { subAccountId } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ error: "Invalid request." }, 400);
  try {
    const { sub } = await requirePortalOpen(subAccountId);
    const identity = parseIdentity(body.identifier);
    const res = await verifyCustomerCode(
      sub,
      identity,
      body.code,
      portalClientIp(request),
      request.headers.get("user-agent") ?? "",
    );
    if (res && "error" in res) return json({ error: "Too many wrong codes. Try again later." }, 429);
    if (!res) return json({ error: "That code isn't right or has expired." }, 401);
    return json({ ok: true }, 200, customerCookieHeader(res.token, subAccountId));
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
