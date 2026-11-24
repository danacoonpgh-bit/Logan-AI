import { json, portalClientIp, publicPortalRoute, sessionCookieHeader, workspaceOf } from "@/lib/field-portal/guard";
import { inWorkspace, parseEmailIdentity } from "@/lib/field-portal/identity";
import { verifyOtp } from "@/lib/server/field-portal-session-service";

export const dynamic = "force-dynamic";

export const POST = publicPortalRoute(async (request) => {
  const body = (await request.json().catch(() => null)) as
    | { identifier?: unknown; code?: unknown; country?: unknown }
    | null;
  const sa = workspaceOf(request);
  const base = parseEmailIdentity(body?.identifier);
  const identity = base && sa ? inWorkspace(base, sa) : null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!identity) return json({ error: "That code didn't work." }, 400);
  const res = await verifyOtp(
    identity,
    code,
    portalClientIp(request),
    request.headers.get("user-agent") ?? "",
  );
  if (res && "error" in res) return json({ error: "Too many tries. Wait a bit and try again." }, 429);
  if (!res) return json({ error: "That code didn't work or has expired." }, 400);
  return json({ ok: true }, 200, sessionCookieHeader(res.token, sa as string));
});
