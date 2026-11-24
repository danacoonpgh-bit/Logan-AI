import "server-only";

import type { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { readJobStatusToken } from "@/lib/field-services/job-status-token";
import { recordFieldActivity } from "@/lib/server/field-events";
import { hitLimit } from "@/lib/server/field-rate-limit";
import { cancelJob } from "@/lib/server/field-jobs-service";
import { claimBookingSlot, listBookingSlots, type BookingSlot } from "@/lib/server/field-booking-slots";
import { loadServices, withVariant, type PublicBookingService } from "@/lib/server/field-booking-service";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { setVisitStatus, updateVisit } from "@/lib/server/field-visits-service";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import type { FieldServicesConfig, Job, Visit } from "@/types/field-services";

const LIVE = ["pending", "on_my_way", "checked_in"];

export type VisitChange = { canCancel: boolean; canMove: boolean; locked: boolean };

function startMs(v: Visit): number {
  return (v.scheduledStart as Timestamp | null)?.toMillis?.() ?? 0;
}

/**
 * What the customer may do with one visit. Locked means it could be changed if it were further away, so the page
 * shows the business's phone number instead.
 */
export function changeRights(config: FieldServicesConfig, job: Job, visit: Visit, canMove: boolean, nowMs = Date.now()): VisitChange {
  const hours = config.customerChangeHours ?? 72;
  const none = { canCancel: false, canMove: false, locked: false };
  if (hours <= 0 || visit.status !== "pending" || job.status === "closed" || job.status === "cancelled") return none;
  if (job.jobType === "recurring" || !visit.scheduledStart) return none;
  const away = startMs(visit) - nowMs;
  if (away <= 0) return none;
  if (away < hours * 3_600_000) return { canCancel: false, canMove: false, locked: true };
  return { canCancel: true, canMove, locked: false };
}

/** The one bookable service a project was booked for, which is what lets a customer pick another time online. */
export async function moveService(config: FieldServicesConfig, job: Job): Promise<PublicBookingService | null> {
  if (config.onlineBookingEnabled !== true || config.bookingInstant !== true) return null;
  const lines = job.lineItems.filter((l) => !l.approvalId);
  const ids = [...new Set(lines.map((l) => l.productId).filter((x): x is string => !!x))];
  if (ids.length !== 1 || !(config.bookingServiceIds ?? []).includes(ids[0])) return null;
  if (!job.serviceAddress?.postcode) return null;
  const service = (await loadServices(job.subAccountId, ids))[0];
  if (!service) return null;
  const variantId = lines.find((l) => l.variantId)?.variantId ?? undefined;
  const picked = withVariant(service, variantId);
  // The line keeps the time the booking took, extras included, so a moved visit is as long as it was.
  const booked = lines.find((l) => l.productId === ids[0])?.durationMinutes;
  return typeof booked === "number" && booked > 0 ? { ...picked, durationMinutes: booked } : picked;
}

async function open(token: unknown, visitId: unknown, ip: string) {
  const [perIp] = await Promise.all([hitLimit(`jobchange:ip:${ip}`, 60, 3_600_000)]);
  if (!perIp.ok) throw new FieldServicesError("Too many tries. Please wait a while.", 429);
  const parsed = readJobStatusToken(token);
  if (!parsed || typeof visitId !== "string") throw new FieldServicesError("This link isn't working.", 404);
  const perJob = await hitLimit(`jobchange:job:${parsed.jobId}`, 30, 3_600_000);
  if (!perJob.ok) throw new FieldServicesError("Too many tries. Please wait a while.", 429);

  const db = getAdminDb();
  const [jobSnap, visitSnap] = await Promise.all([db.doc(`jobs/${parsed.jobId}`).get(), db.doc(`visits/${visitId}`).get()]);
  const job = jobSnap.exists ? ({ id: jobSnap.id, ...jobSnap.data() } as Job) : null;
  const visit = visitSnap.exists ? ({ id: visitSnap.id, ...visitSnap.data() } as Visit) : null;
  if (!job || (job.statusTokenVersion ?? 1) !== parsed.version) throw new FieldServicesError("This link isn't working.", 404);
  if (!visit || visit.jobId !== job.id || visit.subAccountId !== job.subAccountId) {
    throw new FieldServicesError("That visit wasn't found.", 404);
  }
  const config = await getFieldServicesConfig(job.subAccountId);
  const sub = (await db.doc(`subAccounts/${job.subAccountId}`).get()).data();
  const service = await moveService(config, job);
  const rights = changeRights(config, job, visit, service !== null);
  return { job, visit, config, service, rights, agencyId: (sub?.agencyId as string | undefined) ?? job.agencyId };
}

function office(c: Awaited<ReturnType<typeof open>>, title: string, notes: string) {
  return createTaskServerSide({
    subAccountId: c.job.subAccountId,
    agencyId: c.agencyId,
    createdByUid: "customer-page",
    mode: "live",
    title,
    notes,
    dueAt: null,
    contactId: c.job.contactId,
    dealId: c.job.dealId ?? null,
    eventId: null,
  }).catch((err) => console.warn("[field-customer-change] task failed", err));
}

function label(c: Awaited<ReturnType<typeof open>>, ms: number): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: c.job.timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** The customer cancels one visit. A project with no other live visit is cancelled as a whole. */
export async function customerCancelVisit(input: { token: unknown; visitId: unknown; ip: string }): Promise<void> {
  const c = await open(input.token, input.visitId, input.ip);
  if (!c.rights.canCancel) throw new FieldServicesError("This visit can't be cancelled online. Please contact the business.", 409);
  const when = label(c, startMs(c.visit));
  const live = (
    await getAdminDb().collection("visits").where("jobId", "==", c.job.id).get()
  ).docs.filter((d) => LIVE.includes(d.data().status as string) && d.data().subAccountId === c.job.subAccountId);
  const onlyOne = live.length === 1 && live[0].id === c.visit.id;
  if (onlyOne && ((c.job.invoiceIds?.length ?? 0) > 0 || c.job.quoteId || c.job.travelFeeInvoiceId)) {
    throw new FieldServicesError("This can't be cancelled online because it has been invoiced. Please contact the business.", 409);
  }
  const nothingDone = !(await getAdminDb().collection("visits").where("jobId", "==", c.job.id).get()).docs.some(
    (d) => d.data().status === "completed",
  );
  if (onlyOne && nothingDone) await cancelJob({ subAccountId: c.job.subAccountId, jobId: c.job.id });
  else await setVisitStatus({ subAccountId: c.job.subAccountId, visitId: c.visit.id, status: "cancelled", actorUid: "customer-page", isOffice: true });
  await recordFieldActivity(c.job.contactId, "field_visit", `Customer cancelled the visit on ${when} from their page.`, {
    jobId: c.job.id,
    visitId: c.visit.id,
  });
  const paid = (c.job.depositPaidMinor ?? 0) > 0;
  await office(
    c,
    `Customer cancelled their visit (${c.job.number})`,
    `${c.job.contactName ?? "The customer"} cancelled ${c.job.title} on ${when} from their page.${
      paid ? " A deposit was paid. Refund it in Stripe if your refund policy says to." : ""
    }`,
  );
}

/** Open times for the day the customer is looking at. */
export async function customerMoveSlots(input: {
  token: unknown;
  visitId: unknown;
  date: unknown;
  ip: string;
}): Promise<{ slots: BookingSlot[]; timezone: string }> {
  const c = await open(input.token, input.visitId, input.ip);
  if (!c.rights.canMove || !c.service || !c.job.serviceAddress) {
    throw new FieldServicesError("This visit can't be moved online. Please contact the business.", 409);
  }
  const address = c.job.serviceAddress;
  return listBookingSlots(c.job.subAccountId, { ...address, date: input.date }, c.visit.id, c.service);
}

/** Moves the visit to a time the customer picked from the open ones. The person may change, the customer never chooses. */
export async function customerMoveVisit(input: { token: unknown; visitId: unknown; slot: unknown; ip: string }): Promise<{ label: string }> {
  const c = await open(input.token, input.visitId, input.ip);
  if (!c.rights.canMove || !c.service || !c.job.serviceAddress) {
    throw new FieldServicesError("This visit can't be moved online. Please contact the business.", 409);
  }
  const was = label(c, startMs(c.visit));
  const claim = await claimBookingSlot(c.job.subAccountId, c.service, c.job.serviceAddress, input.slot, {
    visitId: c.visit.id,
    workerIds: c.visit.workerIds,
  });
  // Keep the people who were booked when one of them is free; otherwise the office is told who replaced them.
  const kept = claim.workerIds.length === c.visit.workerIds.length && claim.workerIds.every((id) => c.visit.workerIds.includes(id));
  try {
    await updateVisit({
      subAccountId: c.job.subAccountId,
      visitId: c.visit.id,
      body: {
        scheduledStart: claim.start.toISOString(),
        scheduledEnd: claim.end.toISOString(),
        workerIds: claim.workerIds,
        anytime: false,
      },
    });
  } finally {
    await claim.release();
  }
  await office(
    c,
    `Customer moved their visit (${c.job.number})`,
    `${c.job.contactName ?? "The customer"} moved ${c.job.title} from ${was} to ${claim.label} from their page.${kept ? "" : " Their person was not free, so another person has it (or a different crew)."}`,
  );
  return { label: claim.label };
}
