import { json, portalClientIp, publicPortalRoute } from "@/lib/field-portal/guard";
import { previewInvite } from "@/lib/server/field-portal-invite-service";

export const dynamic = "force-dynamic";

export const POST = publicPortalRoute(async (request) => {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const preview = await previewInvite(body?.token, portalClientIp(request));
  if (!preview) return json({ error: "This invite link isn't valid any more." }, 404);
  return json(preview);
});
