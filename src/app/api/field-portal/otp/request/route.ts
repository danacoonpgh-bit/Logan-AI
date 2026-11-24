import { json, portalClientIp, publicPortalRoute, workspaceOf } from "@/lib/field-portal/guard";
import { inWorkspace, parseEmailIdentity } from "@/lib/field-portal/identity";
import { requestOtp } from "@/lib/server/field-portal-session-service";

export const dynamic = "force-dynamic";

export const POST = publicPortalRoute(async (request) => {
  const body = (await request.json().catch(() => null)) as
    | { identifier?: unknown; country?: unknown }
    | null;
  const sa = workspaceOf(request);
  const base = parseEmailIdentity(body?.identifier);
  const identity = base && sa ? inWorkspace(base, sa) : null;
  if (!identity) return json({ error: "Enter your email address." }, 400);
  const res = await requestOtp(identity, portalClientIp(request));
  if (!res.ok) return json({ error: "Too many tries. Wait a bit and try again." }, 429);
  return json({ ok: true });
});
