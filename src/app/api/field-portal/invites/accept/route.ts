import { json, portalClientIp, publicPortalRoute, sessionCookieHeader } from "@/lib/field-portal/guard";
import { acceptInvite } from "@/lib/server/field-portal-invite-service";

export const dynamic = "force-dynamic";

export const POST = publicPortalRoute(async (request) => {
  const body = (await request.json().catch(() => null)) as
    | { token?: unknown; otp?: unknown }
    | null;
  const result = await acceptInvite({
    token: body?.token,
    otp: body?.otp,
    ip: portalClientIp(request),
    userAgent: request.headers.get("user-agent") ?? "",
  });
  if (!result.ok) {
    if (result.reason === "otp_required") {
      return json({ needsOtp: true, sentTo: result.sentTo, sent: result.sent }, 202);
    }
    if (result.reason === "limited") {
      return json({ error: "Too many tries. Wait a bit and try again." }, 429);
    }
    return json({ error: "That link or code didn't work. Ask for a new invite." }, 400);
  }
  return json({ ok: true, subAccountId: result.subAccountId }, 200, sessionCookieHeader(result.token, result.subAccountId));
});
