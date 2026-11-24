import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { portalToday } from "@/lib/server/field-portal-access";

export const dynamic = "force-dynamic";

export const GET = withFieldPerson(async ({ session }) => {
  const visits = await portalToday(session.personId);
  return json({ viewerId: session.personId, visits });
});
