import { json, portalClientIp, sameOrigin } from "@/lib/field-portal/guard";
import { runAfterResponse } from "@/lib/server/after-response";
import {
  allowCodeRequest,
  parseIdentity,
  requirePortalOpen,
  sendCustomerCode,
} from "@/lib/server/field-customer-auth-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

/** Answers the same way whether or not the address or number belongs to a customer. */
export async function POST(request: Request, { params }: { params: Promise<{ subAccountId: string }> }) {
  if (!sameOrigin(request)) return json({ error: "Not allowed." }, 403);
  const { subAccountId } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ error: "Invalid request." }, 400);
  try {
    const { sub } = await requirePortalOpen(subAccountId);
    const identity = parseIdentity(body.identifier);
    const limit = await allowCodeRequest(sub.id, identity, portalClientIp(request));
    if (!limit.ok) return json({ error: "Too many tries. Please wait a few minutes." }, 429);
    runAfterResponse(() => sendCustomerCode(sub, identity));
    return json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
