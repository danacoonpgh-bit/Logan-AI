import "server-only";

import { billingFromServices } from "@/lib/field-services/service-billing";
import { dealPipelineId, getPipeline, wonStageId } from "@/lib/pipelines/resolve";
import { loadResolvedPipelines } from "@/lib/server/pipelines-service";

import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { deriveJobStatus, hasOpenVisit } from "@/lib/field-services/job-status";
import {
  formatServiceAddress,
  sanitizeServiceAddress,
} from "@/lib/field-services/address";
import { issueFieldNumber } from "@/lib/field-services/numbers";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getFieldServicesConfig, getJobTerms } from "@/lib/server/field-services-config-service";
import { activeTimeKinds, defaultActivityIds } from "@/lib/field-services/time-kinds";
import { withArticle } from "@/lib/field-services/terms";
import { existingInvoiceIds, unbilledWork } from "@/lib/server/field-invoicing";
import { resumeDayTimer, stopTimersForJob, stopTimersForVisit } from "@/lib/server/field-time-service";
import { anyInLockedWeek } from "@/lib/server/field-timesheet-service";
import { runAfterResponse } from "@/lib/server/after-response";
import { cancelPendingApprovals } from "@/lib/server/field-approvals-service";
import { cancelPendingSignoffs } from "@/lib/server/field-signoff-service";
import { purgeVisitPhotos } from "@/lib/server/field-photos-service";
import { notifyCrew, notifyCrewOfJobChange } from "@/lib/server/field-crew-notify-service";
import { forcedCurrency } from "@/lib/server/field-currency-service";
import { createVisit } from "@/lib/server/field-visits-service";
import {
  checkServiceArea,
  loadContactForField,
  saveAddressOnContact,
} from "@/lib/server/field-requests-service";
import {
  emitFieldWebhook,
  recordFieldActivity,
  serializeJob,
  serializeVisit,
} from "@/lib/server/field-events";
import {
  SELECTABLE_BILLING_TYPES,
  type Job,
  type JobBillingType,
  type JobLineItem,
  type JobTax,
  type ServiceRequest,
  type TimeKindDef,
  type Visit,
  type VisitStatus,
} from "@/types/field-services";

export function sanitizeJobLines(input: unknown): JobLineItem[] {
  if (!Array.isArray(input)) return [];
  const lines: JobLineItem[] = [];
  for (const raw of input.slice(0, 100)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const description =
      typeof r.description === "string" ? r.description.trim().slice(0, 300) : "";
    const quantity = typeof r.quantity === "number" ? r.quantity : 1;
    const price = typeof r.unitPriceMinor === "number" ? r.unitPriceMinor : 0;
    if (!description || !Number.isFinite(quantity) || quantity <= 0) continue;
    if (!Number.isFinite(price) || price < 0) continue;
    lines.push({
      id: typeof r.id === "string" && r.id ? r.id.slice(0, 64) : `l${lines.length + 1}`,
      description,
      quantity: Math.min(quantity, 100_000),
      unitPriceMinor: Math.round(price),
      productId: typeof r.productId === "string" ? r.productId.slice(0, 128) : null,
      ...(typeof r.variantId === "string" && r.variantId ? { variantId: r.variantId.slice(0, 40) } : {}),
      ...(typeof r.durationMinutes === "number" && r.durationMinutes > 0 ? { durationMinutes: Math.min(1_440, Math.round(r.durationMinutes)) } : {}),
      ...(typeof r.approvalId === "string" && r.approvalId ? { approvalId: r.approvalId.slice(0, 64) } : {}),
      ...(typeof r.workerId === "string" && r.workerId ? { workerId: r.workerId.slice(0, 128) } : {}),
      ...(typeof r.activityId === "string" && r.activityId ? { activityId: r.activityId.slice(0, 40) } : {}),
      ...(r.priceLocked === true ? { priceLocked: true } : {}),
    });
  }
  return lines;
}

/** The ids asked for that the workspace still offers, or null when none were given or none are valid. */
function pickActivities(raw: unknown, kinds: TimeKindDef[] | undefined): string[] | null {
  if (!Array.isArray(raw)) return null;
  const offered = new Set(activeTimeKinds(kinds).map((k) => k.id));
  const ids = [...new Set(raw.filter((x): x is string => typeof x === "string" && offered.has(x)))];
  return ids.length > 0 ? ids : null;
}

function pickBillingType(v: unknown): JobBillingType | null {
  return typeof v === "string" && (SELECTABLE_BILLING_TYPES as string[]).includes(v)
    ? (v as JobBillingType)
    : null;
}

export interface CreateJobInput {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  contactId: string;
  title: string;
  description?: string;
  serviceAddress?: unknown;
  lineItems?: unknown;
  estimateLines?: unknown;
  activityIds?: unknown;
  currency?: unknown;
  requestId?: string | null;
  dealId?: string | null;
  /** The tax a booking was made at, written with the job so it can never be missing. */
  tax?: JobTax | null;
  /** Require the deal to be a won one nobody has started a project from. Off for a deal a request came with. */
  checkDeal?: boolean;
  quoteId?: string | null;
  billingType?: unknown;
  timersEnabled?: unknown;
  hoursOnly?: unknown;
  /** Set when the office creates a project by hand: staff become required, and a fixed price project needs a service and a first visit. */
  manual?: { workerIds: unknown; firstVisit?: { start: unknown; minutes?: unknown } | null };
}

async function subTimezone(subAccountId: string): Promise<string> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const tz = snap.data()?.timezone;
  return typeof tz === "string" && tz ? tz : "UTC";
}

/** A deal can start one project: it must be this customer's, in its pipeline's Won stage, and not already used. */
async function checkDealForJob(subAccountId: string, contactId: string, dealId: string): Promise<void> {
  const db = getAdminDb();
  const deal = (await db.doc(`deals/${dealId}`).get()).data();
  if (!deal || deal.subAccountId !== subAccountId) throw new FieldServicesError("That deal wasn't found.", 404);
  if (deal.contactId !== contactId) throw new FieldServicesError("That deal belongs to a different customer.");
  const pipeline = getPipeline(await loadResolvedPipelines(subAccountId), dealPipelineId(deal));
  if (deal.stageId !== wonStageId(pipeline)) throw new FieldServicesError("Only a won deal can start a project.");
  const used = await db.collection("jobs").where("subAccountId", "==", subAccountId).where("dealId", "==", dealId).get();
  const live = used.docs.find((d) => d.data().status !== "cancelled");
  if (live) {
    throw new FieldServicesError(`That deal already has a project (${String(live.data().number ?? "")}).`, 409);
  }
}

/** A project made from services bills the way they say; a mix of types falls back to the workspace default. */
async function billingFromServiceLines(subAccountId: string, lines: { productId?: string | null }[]) {
  const ids = [...new Set(lines.map((l) => l.productId).filter((id): id is string => !!id))].slice(0, 20);
  if (ids.length === 0) return null;
  const db = getAdminDb();
  const docs = await db.getAll(...ids.map((id) => db.doc(`products/${id}`)));
  const services = docs
    .filter((d) => d.exists && d.data()?.subAccountId === subAccountId && d.data()?.kind === "service")
    .map((d) => d.data() as { billingType?: JobBillingType });
  return billingFromServices(services);
}

/**
 * On a time and materials project a Time & materials service is an estimate, not a charge: its lines move to the
 * project's internal estimate as hours at the service's estimated rate.
 */
async function estimateFromTimeServices(
  subAccountId: string,
  lines: JobLineItem[],
): Promise<{ charges: JobLineItem[]; estimate: JobLineItem[] }> {
  const ids = [...new Set(lines.map((l) => l.productId).filter((id): id is string => !!id))].slice(0, 20);
  if (ids.length === 0) return { charges: lines, estimate: [] };
  const db = getAdminDb();
  const docs = await db.getAll(...ids.map((id) => db.doc(`products/${id}`)));
  const timed = new Map<string, { rate: number; hours: number }>();
  for (const d of docs) {
    const p = d.data();
    if (!d.exists || p?.subAccountId !== subAccountId || p?.kind !== "service" || p?.billingType !== "time_and_materials") continue;
    const rate = typeof p.estimateRateCents === "number" ? p.estimateRateCents : 0;
    const minutes = typeof p.durationMinutes === "number" && p.durationMinutes > 0 ? p.durationMinutes : 60;
    if (rate > 0) timed.set(d.id, { rate, hours: Math.round((minutes / 60) * 10_000) / 10_000 });
  }
  const charges: JobLineItem[] = [];
  const estimate: JobLineItem[] = [];
  for (const l of lines) {
    const t = l.productId ? timed.get(l.productId) : undefined;
    if (!t) charges.push(l);
    else estimate.push({ ...l, quantity: Math.round(l.quantity * t.hours * 10_000) / 10_000, unitPriceMinor: t.rate });
  }
  return { charges, estimate };
}

/** True when at least one line is an active service of this workspace. */
async function hasServiceLine(subAccountId: string, lines: { productId?: string | null }[]): Promise<boolean> {
  const ids = [...new Set(lines.map((l) => l.productId).filter((id): id is string => !!id))].slice(0, 20);
  if (ids.length === 0) return false;
  const db = getAdminDb();
  const docs = await db.getAll(...ids.map((id) => db.doc(`products/${id}`)));
  return docs.some((d) => d.exists && d.data()?.subAccountId === subAccountId && d.data()?.kind === "service");
}

async function activeStaffIds(subAccountId: string, raw: unknown): Promise<string[]> {
  const wanted = Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === "string"))].slice(0, 10) : [];
  if (wanted.length === 0) return [];
  const db = getAdminDb();
  const docs = await db.getAll(...wanted.map((id) => db.doc(`fieldWorkers/${id}`)));
  return docs
    .filter((d) => d.exists && d.data()?.subAccountId === subAccountId && d.data()?.status === "active")
    .map((d) => d.id);
}

export async function createJob(
  input: CreateJobInput,
): Promise<{ id: string; number: string; visitError?: string; warnings?: string[] }> {
  const terms = await getJobTerms(input.subAccountId);
  const title = input.title?.trim().slice(0, 200);
  if (!title) throw new FieldServicesError(`Give the ${terms.job} a title.`);

  const description = typeof input.description === "string" ? input.description.trim().slice(0, 4_000) : "";
  const contact = await loadContactForField(input.subAccountId, input.contactId);
  if (input.dealId && input.checkDeal) await checkDealForJob(input.subAccountId, contact.id, input.dealId);
  const address = sanitizeServiceAddress(input.serviceAddress);
  const area = await checkServiceArea(input.subAccountId, address);
  const timezone = await subTimezone(input.subAccountId);
  const currency = await forcedCurrency(input.subAccountId, input.currency);
  const config = await getFieldServicesConfig(input.subAccountId);
  const lines = sanitizeJobLines(input.lineItems);
  const estimateLines = sanitizeJobLines(input.estimateLines);
  const billingType = config.timesheetsEnabled
    ? (pickBillingType(input.billingType) ??
      (await billingFromServiceLines(input.subAccountId, lines)) ??
      config.defaultBillingType)
    : (await billingFromServiceLines(input.subAccountId, lines)) === "lump_sum"
      ? "lump_sum"
      : null;

  if (config.timesheetsEnabled && billingType !== "lump_sum") {
    const split = await estimateFromTimeServices(input.subAccountId, lines);
    lines.splice(0, lines.length, ...split.charges);
    estimateLines.push(...split.estimate);
  }

  let staffIds: string[] = [];
  const fixed = billingType === "lump_sum";
  if (input.manual) {
    staffIds = await activeStaffIds(input.subAccountId, input.manual.workerIds);
    if (staffIds.length === 0) throw new FieldServicesError(`Choose who will do the work. A ${terms.job} needs at least one staff member.`);
    if (fixed) {
      if (!(await hasServiceLine(input.subAccountId, lines))) {
        throw new FieldServicesError(`A fixed price ${terms.job} must be linked to a service. Add a service to the charges.`);
      }
      if (!input.manual.firstVisit?.start) {
        throw new FieldServicesError("Choose a date and time for the first visit.");
      }
    }
  }
  const number = await issueFieldNumber(input.subAccountId, "job");

  const hoursOnly = config.timesheetsEnabled && input.hoursOnly === true;
  const db = getAdminDb();
  const ref = db.collection("jobs").doc();
  const doc: Omit<Job, "id"> = {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    territoryId: contact.territoryId,
    number,
    contactId: contact.id,
    contactName: contact.name,
    dealId: input.dealId ?? null,
    requestId: input.requestId ?? null,
    ...(input.tax ? { tax: input.tax } : {}),
    quoteId: input.quoteId ?? null,
    invoiceIds: [],
    title,
    ...(description ? { description } : {}),
    serviceAddress: address,
    timezone,
    currency,
    lineItems: lines,
    ...(estimateLines.length > 0 ? { estimateLines } : {}),
    activityIds: pickActivities(input.activityIds, config.timeKinds) ?? defaultActivityIds(config.timeKinds),
    ...(staffIds.length > 0 ? { workerIds: staffIds } : {}),
    timersEnabled: input.timersEnabled === true && !hoursOnly,
    ...(hoursOnly ? { hoursOnly: true } : {}),
    serviceAreaId: area.areaId,
    outOfArea: area.outOfArea,
    travelFeeCents: area.travelFeeCents,
    status: "unscheduled",
    completedAt: null,
    completedFiredAt: null,
    closedAt: null,
    jobType: "one_off",
    recurrence: null,
    ...(billingType ? { billingType } : {}),
    kind: "standard",
    relatedJobId: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);

  await saveAddressOnContact(contact.id, address);
  await recordFieldActivity(
    contact.id,
    "field_job",
    `${terms.Job} ${number} created: ${title}.`,
    { jobId: ref.id },
  );
  emitFieldWebhook({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    type: "job.created",
    payload: { job: serializeJob({ ...doc, id: ref.id, createdAt: new Date() }) },
  });

  // The project stands even if the visit can't be booked; the caller tells the office.
  if (input.manual?.firstVisit?.start && fixed) {
    try {
      const visit = await createVisit({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        createdByUid: input.createdByUid,
        jobId: ref.id,
        scheduledStart: input.manual.firstVisit.start,
        durationMinutes: input.manual.firstVisit.minutes,
        workerIds: staffIds,
      });
      return { id: ref.id, number, ...(visit.warnings.length > 0 ? { warnings: visit.warnings } : {}) };
    } catch (err) {
      return {
        id: ref.id,
        number,
        visitError: err instanceof FieldServicesError ? err.message : "The visit could not be booked.",
      };
    }
  }
  return { id: ref.id, number };
}

export async function createJobFromRequest(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  requestId: string;
  lineItems?: unknown;
  currency?: unknown;
  tax?: JobTax | null;
}): Promise<{ id: string; number: string }> {
  const db = getAdminDb();
  const terms = await getJobTerms(input.subAccountId);
  const reqRef = db.doc(`serviceRequests/${input.requestId}`);

  // Claim the request before creating the job so a double click cannot make two.
  const request = await db.runTransaction(async (tx) => {
    const snap = await tx.get(reqRef);
    const r = snap.data() as ServiceRequest | undefined;
    if (!snap.exists || !r || r.subAccountId !== input.subAccountId) {
      throw new FieldServicesError("Request not found.", 404);
    }
    if (r.status === "converted" || r.convertedTo) {
      throw new FieldServicesError(`This request already became ${withArticle(terms.job)}.`, 409);
    }
    if (r.status === "archived") {
      throw new FieldServicesError(`Restore the request before creating ${withArticle(terms.job)}.`, 409);
    }
    tx.update(reqRef, {
      status: "converted",
      convertedTo: "pending",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return r;
  });

  try {
    let lineItems = input.lineItems;
    let currency = input.currency;
    if (lineItems === undefined && Array.isArray(request.serviceIds) && request.serviceIds.length > 0) {
      const ids = [...new Set(request.serviceIds)].slice(0, 20);
      const docs = await db.getAll(...ids.map((id) => db.doc(`products/${id}`)));
      const services = docs.filter(
        (d) => d.exists && d.data()?.subAccountId === input.subAccountId && d.data()?.kind === "service" && d.data()?.active !== false,
      );
      if (services.length > 0) {
        lineItems = services.map((d) => ({
          id: `s_${d.id}`.slice(0, 64),
          description: String(d.data()?.name ?? "").slice(0, 200),
          quantity: 1,
          unitPriceMinor: Math.max(0, Math.round(Number(d.data()?.unitPriceCents) || 0)),
          productId: d.id,
        }));
        const first = services[0].data()?.currency;
        if (currency === undefined && typeof first === "string" && first) currency = first;
      }
    }
    const job = await createJob({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      createdByUid: input.createdByUid,
      contactId: request.contactId,
      title: request.title,
      description: request.description,
      serviceAddress: request.serviceAddress,
      lineItems,
      currency,
      requestId: input.requestId,
      dealId: request.dealId ?? null,
      tax: input.tax ?? null,
    });
    await reqRef.update({
      convertedTo: job.id,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return job;
  } catch (err) {
    await reqRef
      .update({
        status: request.status,
        convertedTo: null,
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});
    throw err;
  }
}

async function loadJob(subAccountId: string, jobId: string) {
  const ref = getAdminDb().doc(`jobs/${jobId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError(`${(await getJobTerms(subAccountId)).Job} not found.`, 404);
  }
  return { ref, data: { id: snap.id, ...snap.data() } as Job };
}

/** Refused once an estimate or invoice exists or money was confirmed. */
export async function deleteJob(input: { subAccountId: string; jobId: string }): Promise<void> {
  const db = getAdminDb();
  const { ref, data } = await loadJob(input.subAccountId, input.jobId);
  const terms = await getJobTerms(input.subAccountId);
  // A booking deposit or travel fee invoice counts too, so a paid deposit is never left without its job.
  const documents = await existingInvoiceIds([...(data.invoiceIds ?? []), data.depositInvoiceId, data.travelFeeInvoiceId, data.quoteId]);
  if (documents.size > 0) {
    throw new FieldServicesError(`An estimate or invoice was raised from this ${terms.job}. Cancel the ${terms.job} instead.`, 409);
  }
  const wasRepeating = data.jobType === "recurring" && data.recurrence?.active === true;
  // Stop the repeat first so the daily top-up cannot add visits while the job is being removed.
  if (wasRepeating) await ref.update({ "recurrence.active": false });
  try {
  const [visits, time, parts, pays, approvals] = await Promise.all([
    db.collection("visits").where("jobId", "==", data.id).get(),
    db.collection("timeEntries").where("jobId", "==", data.id).get(),
    db.collection("materialLines").where("jobId", "==", data.id).get(),
    db.collection("jobPayments").where("jobId", "==", data.id).get(),
    db.collection("jobApprovals").where("jobId", "==", data.id).get(),
  ]);
  if (pays.docs.some((d) => d.data().status === "confirmed")) {
    throw new FieldServicesError(`Money was confirmed on this ${terms.job}. Cancel the ${terms.job} instead.`, 409);
  }
  const loggedTime = time.docs
    .filter((d) => d.data().voided !== true && d.data().startAt?.toMillis)
    .map((d) => ({ workerId: d.data().workerId as string, startMs: d.data().startAt.toMillis() as number }));
  if (await anyInLockedWeek(data.subAccountId, loggedTime)) {
    throw new FieldServicesError(
      `This ${terms.job} has time in a submitted or approved week. Cancel the ${terms.job} instead, or unlock those weeks first.`,
      409,
    );
  }
  await purgeVisitPhotos(
    data.subAccountId,
    visits.docs.map((d) => ({ id: d.id, ...d.data() }) as Visit),
  );
  for (const group of [visits.docs, time.docs, parts.docs, pays.docs, approvals.docs]) {
    for (let i = 0; i < group.length; i += 400) {
      const batch = db.batch();
      for (const d of group.slice(i, i + 400)) batch.delete(d.ref);
      await batch.commit();
    }
  }
  for (const d of time.docs) await db.recursiveDelete(d.ref);
  // The job goes last, so a failure part way leaves it in the list to delete again.
  await db.recursiveDelete(ref);
  // Timers that ran on the job are gone; anyone clocked in goes back to general time.
  const timedWorkers = new Set(
    time.docs.filter((d) => d.data().running === true).map((d) => d.data().workerId as string),
  );
  for (const w of timedWorkers) await resumeDayTimer(data.subAccountId, w);
  if (data.requestId) {
    await db
      .doc(`serviceRequests/${data.requestId}`)
      .update({
        status: "archived",
        archiveReason: "Deleted with the job",
        convertedTo: null,
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});
  }
  await recordFieldActivity(data.contactId, "field_job", `${terms.Job} ${data.number} deleted.`, {});
  } catch (err) {
    if (wasRepeating) await ref.update({ "recurrence.active": true }).catch(() => {});
    throw err;
  }
}

/** A deal renamed on the pipeline renames its project too. */
export async function syncJobTitleFromDeal(subAccountId: string, dealId: string, title: string): Promise<void> {
  const snap = await getAdminDb()
    .collection("jobs")
    .where("subAccountId", "==", subAccountId)
    .where("dealId", "==", dealId)
    .get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.title === title || d.status === "closed" || d.status === "cancelled") continue;
    await updateJob({ subAccountId, jobId: doc.id, body: { title } }).catch((err) =>
      console.warn("[field-jobs] title sync from deal failed", err),
    );
  }
}

export async function updateJob(input: {
  subAccountId: string;
  jobId: string;
  body: Record<string, unknown>;
}): Promise<void> {
  const { ref, data } = await loadJob(input.subAccountId, input.jobId);
  const terms = await getJobTerms(input.subAccountId);
  if (data.status === "closed" || data.status === "cancelled") {
    throw new FieldServicesError(`A closed or cancelled ${terms.job} can't be edited.`, 409);
  }
  const body = input.body;
  const updates: Record<string, unknown> = {};
  let newBillingType: JobBillingType | null = null;

  if (typeof body.title === "string") {
    const title = body.title.trim().slice(0, 200);
    if (!title) throw new FieldServicesError("Title can't be empty.");
    updates.title = title;
  }
  if (typeof body.description === "string") {
    updates.description = body.description.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").trim().slice(0, 4_000);
  }
  if (body.serviceAddress !== undefined) {
    const address = sanitizeServiceAddress(body.serviceAddress);
    const area = await checkServiceArea(input.subAccountId, address);
    updates.serviceAddress = address;
    updates.outOfArea = area.outOfArea;
    updates.serviceAreaId = area.areaId;
    updates.travelFeeCents = area.travelFeeCents;
    await saveAddressOnContact(data.contactId, address);
  }
  if (body.lineItems !== undefined) updates.lineItems = sanitizeJobLines(body.lineItems);
  if (body.estimateLines !== undefined) updates.estimateLines = sanitizeJobLines(body.estimateLines);
  if (body.activityIds !== undefined) {
    const cfg = await getFieldServicesConfig(input.subAccountId);
    const ids = pickActivities(body.activityIds, cfg.timeKinds);
    if (!ids) throw new FieldServicesError("Keep at least one activity on the project.");
    updates.activityIds = ids;
  }
  if (typeof body.showScopeOnInvoice === "boolean") updates.showScopeOnInvoice = body.showScopeOnInvoice;
  if (body.currency !== undefined) updates.currency = await forcedCurrency(input.subAccountId, body.currency);
  if (typeof body.hoursOnly === "boolean" && body.hoursOnly !== (data.hoursOnly === true)) {
    if (!(await getFieldServicesConfig(input.subAccountId)).timesheetsEnabled) {
      throw new FieldServicesError("Timesheets are switched off for this workspace.", 409);
    }
    // Entries made one way can't be shown the other, so the choice is fixed once time is logged.
    const logged = await getAdminDb()
      .collection("timeEntries")
      .where("subAccountId", "==", input.subAccountId)
      .where("jobId", "==", input.jobId)
      .get();
    if (logged.docs.some((d) => d.data().voided !== true)) {
      throw new FieldServicesError(
        `Time has already been logged on this ${terms.job}, so hours only can't be changed.`,
        409,
      );
    }
    updates.hoursOnly = body.hoursOnly;
    if (body.hoursOnly) updates.timersEnabled = false;
  }
  if (typeof body.timersEnabled === "boolean") {
    if (body.timersEnabled && (updates.hoursOnly ?? data.hoursOnly) === true) {
      throw new FieldServicesError(`A ${terms.job} that records hours only has no timer.`, 409);
    }
    updates.timersEnabled = body.timersEnabled;
  }
  if (body.billingType !== undefined) {
    const billingType = pickBillingType(body.billingType);
    if (!billingType) throw new FieldServicesError("Choose time & materials, day rate or fixed price.");
    if (billingType !== data.billingType) {
      if (!(await getFieldServicesConfig(input.subAccountId)).timesheetsEnabled) {
        throw new FieldServicesError("Timesheets are switched off for this workspace.", 409);
      }
      // A deleted invoice no longer locks the type.
      if ((await existingInvoiceIds(data.invoiceIds)).size > 0) {
        throw new FieldServicesError(
          `An invoice was already raised from this ${terms.job}, so its billing type can't change.`,
          409,
        );
      }
      newBillingType = billingType;
    }
  }
  if (Object.keys(updates).length === 0 && !newBillingType) {
    throw new FieldServicesError("Nothing to update.");
  }
  if (newBillingType) {
    // Re-read in a transaction so an invoice drafted a moment ago cannot slip past the lock.
    await getAdminDb().runTransaction(async (tx) => {
      const fresh = (await tx.get(ref)).data() as Job | undefined;
      if (!fresh) throw new FieldServicesError(`${terms.Job} not found.`, 404);
      if (fresh.invoiceIds.length !== data.invoiceIds.length) {
        throw new FieldServicesError(`An invoice was just raised from this ${terms.job}, so its billing type can't change.`, 409);
      }
      tx.update(ref, { billingType: newBillingType, updatedAt: FieldValue.serverTimestamp() });
    });
    if (Object.keys(updates).length === 0) return;
  }
  updates.updatedAt = FieldValue.serverTimestamp();
  if (updates.lineItems !== undefined) {
    const expected = typeof body.lineItemsVersion === "number" ? body.lineItemsVersion : -1;
    await getAdminDb().runTransaction(async (tx) => {
      const fresh = (await tx.get(ref)).data() as Job | undefined;
      if (!fresh) throw new FieldServicesError(`${terms.Job} not found.`, 404);
      if ((fresh.lineItemsVersion ?? 0) !== expected) {
        throw new FieldServicesError(
          `The ${terms.job} changed while you were editing, for example the customer approved extra work. The lines were reloaded. Check them and save again.`,
          409,
        );
      }
      tx.update(ref, { ...updates, lineItemsVersion: (fresh.lineItemsVersion ?? 0) + 1 });
    });
  } else {
    await ref.update(updates);
  }

  if (updates.title !== undefined && data.dealId && updates.title !== data.title) {
    // The deal skips the sync back when its title already matches.
    const { updateDealServerSide } = await import("@/lib/server/deals-service");
    await updateDealServerSide({
      dealId: data.dealId,
      patch: { title: updates.title as string },
      userId: "field-services",
      expectedSubAccountId: input.subAccountId,
    }).catch((err) => console.warn("[field-jobs] title sync to deal failed", err));
  }

  if (updates.title !== undefined || updates.serviceAddress !== undefined) {
    const db = getAdminDb();
    const open = await db.collection("visits").where("jobId", "==", input.jobId).get();
    const batch = db.batch();
    for (const v of open.docs) {
      if (["completed", "no_show", "cancelled"].includes(v.data().status)) continue;
      batch.update(v.ref, {
        ...(updates.title !== undefined ? { jobTitle: updates.title } : {}),
        ...(updates.serviceAddress !== undefined
          ? { address: formatServiceAddress(updates.serviceAddress as Job["serviceAddress"]) }
          : {}),
      });
    }
    await batch.commit();
  }

  const addressChanged =
    updates.serviceAddress !== undefined &&
    formatServiceAddress(updates.serviceAddress as Job["serviceAddress"]) !== (data.serviceAddress ? formatServiceAddress(data.serviceAddress) : "");
  const detailsChanged =
    (updates.title !== undefined && updates.title !== data.title) ||
    (updates.description !== undefined && updates.description !== (data.description ?? ""));
  if (addressChanged || detailsChanged) {
    const detail = addressChanged && detailsChanged ? "Address and details changed" : addressChanged ? "Address changed" : "Details changed";
    runAfterResponse(() => notifyCrewOfJobChange({ jobId: input.jobId, detail }));
  }
}

export async function closeJob(input: {
  subAccountId: string;
  jobId: string;
}): Promise<void> {
  const db = getAdminDb();
  const terms = await getJobTerms(input.subAccountId);
  const jobRef = db.doc(`jobs/${input.jobId}`);
  let closedJob: Job | null = null;

  const pre = (await jobRef.get()).data() as Job | undefined;
  if (pre && pre.subAccountId === input.subAccountId && pre.status !== "closed" && pre.status !== "cancelled") {
    const owed = await unbilledWork({ ...pre, id: input.jobId });
    if (owed.length > 0) {
      throw new FieldServicesError(`Invoice this ${terms.job} before closing it. Not on an invoice yet: ${owed.join(", ")}.`, 409);
    }
  }

  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    const job = jobSnap.data() as Job | undefined;
    if (!jobSnap.exists || !job || job.subAccountId !== input.subAccountId) {
      throw new FieldServicesError(`${terms.Job} not found.`, 404);
    }
    if (job.status === "closed") return;
    if (job.status === "cancelled") {
      throw new FieldServicesError(`A cancelled ${terms.job} can't be closed.`, 409);
    }
    if (job.jobType === "recurring" && job.recurrence?.active === true) {
      throw new FieldServicesError(`This ${terms.job} still repeats. Stop the repeat before closing it.`, 409);
    }
    const visits = await tx.get(db.collection("visits").where("jobId", "==", input.jobId));
    if (hasOpenVisit(visits.docs.map((d) => d.data().status as VisitStatus))) {
      throw new FieldServicesError(
        `Finish or cancel the open visits before closing this ${terms.job}.`,
        409,
      );
    }
    tx.update(jobRef, {
      status: "closed",
      closedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    closedJob = { ...job, id: jobSnap.id };
  });

  const data = closedJob as Job | null;
  if (!data) return;
  await cancelPendingApprovals(data.id).catch(() => {});
  await cancelPendingSignoffs(data.id).catch(() => {});
  const visitSnap = await db.collection("visits").where("jobId", "==", data.id).get();
  for (const v of visitSnap.docs) {
    await stopTimersForVisit(data.subAccountId, v.id).catch((err) =>
      console.warn("[field-jobs] stopping timers failed", err),
    );
  }
  await stopTimersForJob(data.subAccountId, data.id).catch((err) =>
    console.warn("[field-jobs] stopping job timers failed", err),
  );
  await recordFieldActivity(data.contactId, "field_job", `${terms.Job} ${data.number} closed.`, {
    jobId: data.id,
  });
  emitFieldWebhook({
    subAccountId: data.subAccountId,
    agencyId: data.agencyId,
    type: "job.closed",
    payload: { job: serializeJob({ ...data, status: "closed", closedAt: new Date() }) },
  });
}

/** Undo a close: the project goes back to the status its visits give it. */
export async function reopenJob(input: { subAccountId: string; jobId: string }): Promise<void> {
  const db = getAdminDb();
  const terms = await getJobTerms(input.subAccountId);
  const jobRef = db.doc(`jobs/${input.jobId}`);
  let reopened: Job | null = null;

  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    const job = jobSnap.data() as Job | undefined;
    if (!jobSnap.exists || !job || job.subAccountId !== input.subAccountId) {
      throw new FieldServicesError(`${terms.Job} not found.`, 404);
    }
    if (job.status !== "closed") return;
    const visits = await tx.get(db.collection("visits").where("jobId", "==", input.jobId));
    let next = deriveJobStatus("unscheduled", visits.docs.map((d) => d.data().status as VisitStatus), {
      repeating: job.jobType === "recurring" && job.recurrence?.active === true,
    });
    if (job.jobType === "recurring" && job.recurrence?.active === true && next === "ready_to_invoice") next = "scheduled";
    tx.update(jobRef, { status: next, closedAt: null, updatedAt: FieldValue.serverTimestamp() });
    reopened = { ...job, id: jobSnap.id };
  });

  const data = reopened as Job | null;
  if (!data) return;
  await recordFieldActivity(data.contactId, "field_job", `${terms.Job} ${data.number} reopened.`, { jobId: data.id });
}

export async function cancelJob(input: {
  subAccountId: string;
  jobId: string;
}): Promise<void> {
  const db = getAdminDb();
  const terms = await getJobTerms(input.subAccountId);
  const jobRef = db.doc(`jobs/${input.jobId}`);
  let cancelledJob: Job | null = null;
  const cancelledVisits: Visit[] = [];

  await db.runTransaction(async (tx) => {
    cancelledVisits.length = 0;
    const jobSnap = await tx.get(jobRef);
    const job = jobSnap.data() as Job | undefined;
    if (!jobSnap.exists || !job || job.subAccountId !== input.subAccountId) {
      throw new FieldServicesError(`${terms.Job} not found.`, 404);
    }
    if (job.status === "cancelled") return;
    if (job.status === "closed") {
      throw new FieldServicesError(`A closed ${terms.job} can't be cancelled.`, 409);
    }
    const visits = await tx.get(db.collection("visits").where("jobId", "==", input.jobId));
    for (const v of visits.docs) {
      const status = v.data().status as VisitStatus;
      if (status === "pending" || status === "on_my_way" || status === "checked_in") {
        tx.update(v.ref, {
          status: "cancelled",
          reminderVersion: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
        cancelledVisits.push({ ...(v.data() as Visit), id: v.id, status: "cancelled" });
      }
    }
    tx.update(jobRef, {
      status: "cancelled",
      ...(job.jobType === "recurring" && job.recurrence ? { "recurrence.active": false } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    cancelledJob = { ...job, id: jobSnap.id };
  });

  const data = cancelledJob as Job | null;
  if (!data) return;
  await cancelPendingApprovals(data.id).catch(() => {});
  await cancelPendingSignoffs(data.id).catch(() => {});
  await stopTimersForJob(data.subAccountId, data.id).catch(() => {});
  await recordFieldActivity(data.contactId, "field_job", `${terms.Job} ${data.number} cancelled.`, {
    jobId: data.id,
  });
  for (const v of cancelledVisits) {
    await stopTimersForVisit(v.subAccountId, v.id).catch(() => {});
    runAfterResponse(() => notifyCrew({ visitId: v.id, workerIds: v.workerIds, kind: "cancelled" }));
    emitFieldWebhook({
      subAccountId: v.subAccountId,
      agencyId: v.agencyId,
      type: "visit.cancelled",
      payload: { visit: serializeVisit(v) },
    });
  }
}

/**
 * A project keeps a copy of the customer's name. Contacts are edited straight in the browser, so the copy can fall behind;
 * this brings the project and its visits back in line with the contact. Returns the live name, or null when the contact is gone.
 */
export async function refreshJobCustomerName(input: { subAccountId: string; jobId: string }): Promise<{ name: string | null }> {
  const db = getAdminDb();
  const job = (await db.doc(`jobs/${input.jobId}`).get()).data() as Job | undefined;
  if (!job || job.subAccountId !== input.subAccountId) throw new FieldServicesError("Not found.", 404);
  const contact = (await db.doc(`contacts/${job.contactId}`).get()).data();
  if (!contact || contact.subAccountId !== input.subAccountId) return { name: null };
  const name = typeof contact.name === "string" ? contact.name : "";
  if (!name || name === job.contactName) return { name: name || null };
  const visits = await db.collection("visits").where("jobId", "==", input.jobId).get();
  await updateInChunks(visits.docs.map((v) => v.ref), { contactName: name });
  await db.doc(`jobs/${input.jobId}`).update({ contactName: name });
  return { name };
}

/** Updates many documents without passing the 500 write limit of one batch. */
async function updateInChunks(refs: DocumentReference[], data: Record<string, unknown>): Promise<void> {
  const db = getAdminDb();
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const r of refs.slice(i, i + 400)) batch.update(r, data);
    await batch.commit();
  }
}

/**
 * Moves a project to another customer. Only while nothing has gone to or been answered by the old one: no invoice,
 * linked deal, extra-work answer or sign-off. Visits and the request follow, and the old customer page link stops working.
 */
export async function changeJobCustomer(input: { subAccountId: string; jobId: string; contactId: string }): Promise<{ name: string }> {
  const db = getAdminDb();
  const terms = await getJobTerms(input.subAccountId);
  const ref = db.doc(`jobs/${input.jobId}`);
  const job = (await ref.get()).data() as Job | undefined;
  if (!job || job.subAccountId !== input.subAccountId) throw new FieldServicesError("Not found.", 404);
  if (job.status === "closed" || job.status === "cancelled") {
    throw new FieldServicesError(`A ${job.status} ${terms.job} can't be moved to another customer.`, 409);
  }
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(input.contactId)) throw new FieldServicesError("Pick a customer.");
  if (input.contactId === job.contactId) throw new FieldServicesError("That is already the customer.", 409);
  const contact = (await db.doc(`contacts/${input.contactId}`).get()).data();
  if (!contact || contact.subAccountId !== input.subAccountId) throw new FieldServicesError("Customer not found.", 404);

  const documents = await existingInvoiceIds([...(job.invoiceIds ?? []), job.depositInvoiceId, job.travelFeeInvoiceId, job.quoteId]);
  if (documents.size > 0) {
    throw new FieldServicesError(`This ${terms.job} already has an invoice or estimate, so its customer can't change. Make a new ${terms.job} for the right customer.`, 409);
  }
  if (job.dealId) {
    throw new FieldServicesError(`This ${terms.job} is linked to a deal for the current customer. Unlink the deal first.`, 409);
  }
  const [approvals, visitSnap, requestSnap] = await Promise.all([
    db.collection("jobApprovals").where("jobId", "==", input.jobId).limit(1).get(),
    db.collection("visits").where("jobId", "==", input.jobId).get(),
    db.collection("serviceRequests").where("subAccountId", "==", input.subAccountId).where("convertedTo", "==", input.jobId).get(),
  ]);
  if (!approvals.empty || visitSnap.docs.some((v) => v.data().signoff)) {
    throw new FieldServicesError(`The current customer has already answered extra work or signed off on this ${terms.job}, so it can't change.`, 409);
  }

  const name = typeof contact.name === "string" && contact.name ? contact.name : String(contact.email ?? contact.phone ?? "Customer");
  // The project goes last, so a failure part way leaves it on the old customer and the move can simply be tried again.
  const follow = { contactId: input.contactId, contactName: name };
  await updateInChunks([...visitSnap.docs.map((v) => v.ref), ...requestSnap.docs.map((r) => r.ref)], follow);
  await ref.update({
    ...follow,
    statusTokenVersion: (job.statusTokenVersion ?? 1) + 1,
    updatedAt: FieldValue.serverTimestamp(),
  });

  runAfterResponse(async () => {
    await recordFieldActivity(input.contactId, "field_job", `${terms.Job} ${job.number} was added to this customer.`, { jobId: input.jobId });
    await recordFieldActivity(job.contactId, "field_job", `${terms.Job} ${job.number} was moved to another customer.`, { jobId: input.jobId });
  });
  return { name };
}
