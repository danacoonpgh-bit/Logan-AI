import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { getPerson, listActiveLinks, listDevices } from "@/lib/server/field-portal-session-service";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { jobTerms } from "@/lib/field-services/terms";

export const dynamic = "force-dynamic";

export const GET = withFieldPerson(async ({ session }) => {
  const [person, links, devices] = await Promise.all([
    getPerson(session.personId),
    listActiveLinks(session.personId),
    listDevices(session.personId, session.deviceId),
  ]);
  if (!person) return json({ error: "Sign in required" }, 401);
  const businesses = await Promise.all(
    links.map(async (l) => {
      const config = await getFieldServicesConfig(l.subAccountId).catch(() => null);
      const terms = jobTerms(config);
      return {
        subAccountId: l.subAccountId,
        name: l.businessName,
        timesheets: config?.timesheetsEnabled === true,
        jobWord: terms.Job,
        jobWordPlural: terms.Jobs,
      };
    }),
  );
  // The employer keeps these details, so an edit in the staff list shows here straight away.
  const own = links.find((l) => l.subAccountId === session.subAccountId);
  return json({ person: {
      ...person,
      name: own?.name || person.name,
      email: own?.email || person.email,
      phone: own?.phone || person.phone,
    }, businesses, devices });
});
