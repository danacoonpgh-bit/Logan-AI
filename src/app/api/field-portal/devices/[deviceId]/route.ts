import { clearCookieHeader, json, withFieldPerson } from "@/lib/field-portal/guard";
import { signOutDevice } from "@/lib/server/field-portal-session-service";

export const dynamic = "force-dynamic";

export const DELETE = withFieldPerson<{ deviceId: string }>(async ({ session, subAccountId, params }) => {
  if (!/^[a-f0-9]{32}$/.test(params.deviceId)) return json({ error: "Not found" }, 404);
  await signOutDevice(session.personId, params.deviceId);
  return json({ ok: true }, 200, params.deviceId === session.deviceId ? clearCookieHeader(subAccountId) : undefined);
});
