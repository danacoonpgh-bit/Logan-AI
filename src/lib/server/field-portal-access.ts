import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { json } from "@/lib/field-portal/guard";
import { hitLimit } from "@/lib/server/field-rate-limit";
import {
  requireLink,
  listActiveLinks,
  type PortalLink,
  type PortalSession,
} from "@/lib/server/field-portal-session-service";
import { todayForWorker, type TodayVisit } from "@/lib/server/field-today-service";
import type { FieldActor } from "@/lib/server/field-access";

export interface PortalAccess {
  link: PortalLink;
  actor: FieldActor;
}

export async function crewActionAllowed(personId: string, visitId: string): Promise<boolean> {
  return (await hitLimit(`crew:act:${personId}:${visitId}`, 60, 3_600_000)).ok;
}

/** Taps on the time screens: clock, timers and added time. */
export async function crewTimeAllowed(personId: string): Promise<boolean> {
  return (await hitLimit(`crew:time:${personId}`, 240, 3_600_000)).ok;
}

export function portalActor(personId: string, link: PortalLink): FieldActor {
  return { uid: `fieldPerson:${personId}`, isOffice: false, workerId: link.workerId };
}

type Scoped = "visits" | "materialLines" | "timeEntries";

/** Resolves the person's active link for this business and checks the document is theirs to touch. */
export async function portalAccess(
  ctx: { session: PortalSession },
  subAccountId: string,
  collection: Scoped,
  id: string,
): Promise<PortalAccess | Response> {
  const notFound = json({ error: "Not found." }, 404);
  const ID = /^[A-Za-z0-9_-]{6,80}$/;
  if (!ID.test(subAccountId) || !ID.test(id)) return notFound;
  const link = await requireLink(ctx.session.personId, subAccountId);
  if (!link) return notFound;

  const db = getAdminDb();
  const snap = await db.doc(`${collection}/${id}`).get();
  const doc = snap.data();
  if (!doc || doc.subAccountId !== subAccountId) return notFound;

  let assigned = false;
  if (collection === "visits") {
    assigned = (doc.workerIds as string[] | undefined)?.includes(link.workerId) === true;
  } else if (collection === "timeEntries" && !doc.visitId) {
    // Time on a job or internal job has no visit, so it is theirs when they logged it.
    assigned = doc.workerId === link.workerId;
  } else {
    const visit = (await db.doc(`visits/${doc.visitId}`).get()).data();
    assigned =
      visit?.subAccountId === subAccountId &&
      (visit.workerIds as string[] | undefined)?.includes(link.workerId) === true;
  }
  if (!assigned) return notFound;
  return { link, actor: portalActor(ctx.session.personId, link) };
}

export function projectVisit(v: TodayVisit, link: PortalLink): TodayVisit {
  const prices = link.canHandlePrices;
  const contact = link.canSeeCustomerContact;
  return {
    ...v,
    perms: { prices, contact },
    visit: {
      ...v.visit,
      photos: prices
        ? v.visit.photos
        : v.visit.photos.filter((p) => p.label !== "receipt" || p.byWorkerId === link.workerId),
    },
    customer: { name: v.customer.name, phone: contact ? v.customer.phone : "" },
    job: {
      ...v.job,
      invoiceIds: prices ? v.job.invoiceIds : [],
      pricing: prices ? v.job.pricing : null,
      // The request text and the office's notes can hold contact details and prices.
      description: contact ? v.job.description : "",
      notes: contact ? v.job.notes : v.job.notes.filter((n) => n.mine),
    },
    materials: v.materials.map((m) =>
      prices ? m : { ...m, unitPriceMinor: 0, unitCostMinor: 0 },
    ) as TodayVisit["materials"],
    payments: prices ? v.payments : [],
  };
}

export async function portalToday(personId: string): Promise<TodayVisit[]> {
  const links = await listActiveLinks(personId);
  const groups = await Promise.all(
    links.map(async (link) => {
      const res = await todayForWorker({ subAccountId: link.subAccountId, workerId: link.workerId });
      return res.visits.map((v) => projectVisit(v, link));
    }),
  );
  return groups
    .flat()
    .sort((a, b) => (a.visit.scheduledStart ?? "").localeCompare(b.visit.scheduledStart ?? ""));
}
