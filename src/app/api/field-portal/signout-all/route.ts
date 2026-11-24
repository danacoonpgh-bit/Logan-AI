import { clearCookieHeader, json, withFieldPerson } from "@/lib/field-portal/guard";
import { signOutEverywhere } from "@/lib/server/field-portal-session-service";

export const dynamic = "force-dynamic";

export const POST = withFieldPerson(async ({ session, subAccountId }) => {
  await signOutEverywhere(session.personId);
  return json({ ok: true }, 200, clearCookieHeader(subAccountId));
});
