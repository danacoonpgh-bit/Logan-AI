import { clearCookieHeader, json, withFieldPerson } from "@/lib/field-portal/guard";
import { signOutDevice } from "@/lib/server/field-portal-session-service";

export const dynamic = "force-dynamic";

export const POST = withFieldPerson(async ({ session, subAccountId }) => {
  await signOutDevice(session.personId, session.deviceId);
  return json({ ok: true }, 200, clearCookieHeader(subAccountId));
});
