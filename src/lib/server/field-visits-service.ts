import { jobAllowanceMinutes } from "@/lib/field-services/duration";
import { cleanTravelMinutes, MAX_TRAVEL_MINUTES, tooClose } from "@/lib/field-services/travel";
import { workerFitWarnings } from "@/lib/server/field-worker-fit";
import "server-only";

import {
  FieldValue,
  Timestamp,
  type Transaction,
  type DocumentReference,
} from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { deriveJobStatus } from "@/lib/field-services/job-status";
import { formatServiceAddress } from "@/lib/field-services/address";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { workerForUid } from "@/lib/server/field-access";
import { moveDealToWonWhenScheduled, runJobCompletedFollowups } from "@/lib/server/field-job-followups";
import { getFieldServicesConfig, getJobTerms } from "@/lib/server/field-services-config-service";
import { stopTimersForVisit, stopTimersForWorkers } from "@/lib/server/field-time-service";
import {
  scheduleVisitReminder,
  sendVisitMessage,
} from "@/lib/server/field-messages-service";
import { runAfterResponse } from "@/lib/server/after-response";
import { notifyCrew } from "@/lib/server/field-crew-notify-service";
import { requiredLeft, seedVisitChecklist } from "@/lib/server/field-checklists-service";
import { cancelPendingSignoffsForVisit } from "@/lib/server/field-signoff-service";

export { actorIsOffice, workerForUid } from "@/lib/server/field-access";
import {
  emitFieldWebhook,
  fireFieldTrigger,
  recordFieldActivity,
  serializeJob,
  serializeVisit,
} from "@/lib/server/field-events";
import type {
  FieldWorker,
  Job,
  Visit,
  VisitStatus,
} from "@/types/field-services";
import type { WebhookEventType } from "@/types/webhooks";
import type { WorkflowTriggerType } from "@/types/workflows";

const FINAL: VisitStatus[] = ["completed", "no_show", "cancelled"];

const TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  pending: ["on_my_way", "checked_in", "completed", "no_show", "cancelled"],
  on_my_way: ["checked_in", "completed", "no_show", "cancelled"],
  checked_in: ["completed", "no_show", "cancelled"],
  completed: [],
  no_show: [],
  cancelled: [],
};

const STATUS_EVENT: Partial<Record<VisitStatus, WebhookEventType>> = {
  on_my_way: "visit.on_my_way",
  checked_in: "visit.checked_in",
  completed: "visit.completed",
  no_show: "visit.no_show",
  cancelled: "visit.cancelled",
};

const STATUS_TRIGGER: Partial<Record<VisitStatus, WorkflowTriggerType>> = {
  on_my_way: "visit.on_my_way",
  completed: "visit.completed",
  no_show: "visit.no_show",
};

const STATUS_TEXT: Record<VisitStatus, string> = {
  pending: "scheduled",
  on_my_way: "on the way",
  checked_in: "started",
  completed: "completed",
  no_show: "marked as a no-show",
  cancelled: "cancelled",
};

function parseDate(v: unknown, label: string): Date {
  const d = typeof v === "string" || typeof v === "number" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) {
    throw new FieldServicesError(`${label} isn't a valid date and time.`);
  }
  return d;
}

function toDate(v: unknown): Date | null {
  const t = v as { toDate?: () => Date } | null | undefined;
  return t && typeof t.toDate === "function" ? t.toDate() : null;
}

async function resolveWorkers(
  subAccountId: string,
  ids: unknown,
): Promise<FieldWorker[]> {
  if (ids === undefined) return [];
  if (!Array.isArray(ids)) throw new FieldServicesError("Workers must be a list.");
  const wanted = [...new Set(ids.filter((i): i is string => typeof i === "string"))];
  if (wanted.length > 10) throw new FieldServicesError("A visit can have at most 10 workers.");
  if (wanted.length === 0) return [];
  const db = getAdminDb();
  const snaps = await Promise.all(wanted.map((id) => db.doc(`fieldWorkers/${id}`).get()));
  return snaps.map((s, i) => {
    const d = s.data();
    if (!s.exists || d?.subAccountId !== subAccountId || d?.status !== "active") {
      throw new FieldServicesError(`Worker ${wanted[i]} isn't available.`);
    }
    return { id: s.id, ...d } as FieldWorker;
  });
}

/** Who already has a visit on top of this time, and who has one too close for the travel time either side. */
export async function findScheduleClashes(input: {
  subAccountId: string;
  workerIds: string[];
  start: Date;
  end: Date;
  travelMinutes?: number;
  ignoreVisitId?: string;
}): Promise<{ overlap: string[]; tight: string[] }> {
  const overlap = new Set<string>();
  const tight = new Set<string>();
  const db = getAdminDb();
  for (const workerId of input.workerIds) {
    const snap = await db
      .collection("visits")
      .where("subAccountId", "==", input.subAccountId)
      .where("workerIds", "array-contains", workerId)
      .where("scheduledStart", ">=", Timestamp.fromMillis(input.start.getTime() - 24 * 3_600_000))
      .where("scheduledStart", "<", Timestamp.fromMillis(input.end.getTime() + MAX_TRAVEL_MINUTES * 60_000))
      .get();
    for (const d of snap.docs) {
      if (d.id === input.ignoreVisitId) continue;
      const v = d.data() as Visit;
      if (FINAL.includes(v.status)) continue;
      const vs = toDate(v.scheduledStart);
      const ve = toDate(v.scheduledEnd);
      if (!vs || !ve) continue;
      if (vs < input.end && ve > input.start) overlap.add(workerId);
      else if (tooClose({ start: vs.getTime(), end: ve.getTime(), travelMinutes: v.travelMinutes }, input.start.getTime(), input.end.getTime(), input.travelMinutes)) {
        tight.add(workerId);
      }
    }
  }
  return { overlap: [...overlap], tight: [...tight] };
}

export async function findConflicts(input: {
  subAccountId: string;
  workerIds: string[];
  start: Date;
  end: Date;
  ignoreVisitId?: string;
}): Promise<string[]> {
  return (await findScheduleClashes(input)).overlap;
}

interface JobWriteResult {
  completedNow: boolean;
  status: Job["status"];
}

function applyJobStatus(
  tx: Transaction,
  jobRef: DocumentReference,
  job: Job,
  visitStatuses: VisitStatus[],
): JobWriteResult {
  let next = deriveJobStatus(job.status, visitStatuses, { repeating: job.jobType === "recurring" && job.recurrence?.active === true });
  // A repeating job is never "done" while the repeat is running.
  if (job.jobType === "recurring" && job.recurrence?.active === true && next === "ready_to_invoice") {
    next = "scheduled";
  }
  const patch: Record<string, unknown> = {};
  let completedNow = false;
  if (next !== job.status) patch.status = next;
  if (next === "ready_to_invoice" && !job.completedFiredAt) {
    patch.completedAt = FieldValue.serverTimestamp();
    patch.completedFiredAt = FieldValue.serverTimestamp();
    completedNow = true;
  }
  if (Object.keys(patch).length > 0) {
    patch.updatedAt = FieldValue.serverTimestamp();
    tx.update(jobRef, patch);
  }
  return { completedNow, status: next };
}

function announceJobCompleted(job: Job) {
  runAfterResponse(() => runJobCompletedFollowups(job));
  runAfterResponse(() =>
    getJobTerms(job.subAccountId).then((terms) =>
      recordFieldActivity(job.contactId, "field_job", `${terms.Job} ${job.number} completed.`, {
        jobId: job.id,
      }),
    ),
  );
  emitFieldWebhook({
    subAccountId: job.subAccountId,
    agencyId: job.agencyId,
    type: "job.completed",
    payload: {
      job: serializeJob({ ...job, status: "ready_to_invoice", completedAt: new Date() }),
    },
  });
  fireFieldTrigger({
    subAccountId: job.subAccountId,
    agencyId: job.agencyId,
    type: "job.completed",
    contactId: job.contactId,
    context: { jobId: job.id },
  });
}

export interface CreateVisitInput {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  jobId: string;
  scheduledStart: unknown;
  scheduledEnd?: unknown;
  durationMinutes?: unknown;
  anytime?: unknown;
  workerIds?: unknown;
  notes?: unknown;
  autoScheduled?: boolean;
}

/** Tells the customer and crew about a new visit. */
function announceVisitScheduled(visit: Visit, job: Job, start: Date): void {
  emitFieldWebhook({
    subAccountId: job.subAccountId,
    agencyId: job.agencyId,
    type: "visit.scheduled",
    payload: { visit: serializeVisit(visit) },
  });
  fireFieldTrigger({
    subAccountId: job.subAccountId,
    agencyId: job.agencyId,
    type: "visit.scheduled",
    contactId: job.contactId,
    context: { jobId: job.id, visitId: visit.id, workerIds: visit.workerIds },
  });
  runAfterResponse(async () => {
    await sendVisitMessage("scheduled", visit.id);
    await scheduleVisitReminder({
      id: visit.id,
      scheduledStart: start,
      reminderVersion: visit.reminderVersion ?? 1,
      timezone: job.timezone,
    });
    await notifyCrew({ visitId: visit.id, workerIds: visit.workerIds, kind: "assigned" });
  });
}

/** The time the job's services are expected to take, and the travel time kept free around a visit. */
async function jobAllowance(subAccountId: string, jobId: string): Promise<{ minutes: number; travel: number }> {
  const db = getAdminDb();
  const job = (await db.doc(`jobs/${jobId}`).get()).data() as Job | undefined;
  if (!job || job.subAccountId !== subAccountId) return { minutes: 0, travel: 0 };
  const ids = [...new Set(job.lineItems.filter((l) => !l.approvalId && l.productId).map((l) => l.productId as string))].slice(0, 20);
  if (ids.length === 0) return { minutes: 0, travel: 0 };
  const docs = await db.getAll(...ids.map((id) => db.doc(`products/${id}`)));
  const mine = docs.filter((d) => d.exists && d.data()?.subAccountId === subAccountId);
  const services = mine.map((d) => ({ id: d.id, durationMinutes: d.data()?.durationMinutes as number | undefined }));
  // A job with several services keeps the largest allowance, since the drive is made once.
  const travel = Math.max(0, ...mine.map((d) => cleanTravelMinutes(d.data()?.travelMinutes)));
  return { minutes: jobAllowanceMinutes(job.lineItems, services), travel };
}

export async function createVisit(
  input: CreateVisitInput,
): Promise<{ id: string; warnings: string[] }> {
  const db = getAdminDb();
  const start = parseDate(input.scheduledStart, "Start");
  let end: Date;
  const allowance = await jobAllowance(input.subAccountId, input.jobId);
  if (input.scheduledEnd !== undefined && input.scheduledEnd !== null) {
    end = parseDate(input.scheduledEnd, "End");
  } else {
    const mins =
      typeof input.durationMinutes === "number" && input.durationMinutes > 0
        ? Math.min(input.durationMinutes, 1_440)
        : allowance.minutes || 60;
    end = new Date(start.getTime() + mins * 60_000);
  }
  if (end <= start) throw new FieldServicesError("The end must be after the start.");

  const workers = await resolveWorkers(input.subAccountId, input.workerIds);
  const workerIds = workers.map((w) => w.id);
  const anytime = input.anytime === true;

  const jobRef = db.doc(`jobs/${input.jobId}`);
  const visitRef = db.collection("visits").doc();
  let jobAfter: Job | null = null;
  let completedNow = false;
  let visitDoc: Omit<Visit, "id"> | null = null;
  const preJob = (await jobRef.get()).data() as Job | undefined;
  const checklist =
    preJob && preJob.subAccountId === input.subAccountId
      ? await seedVisitChecklist(input.subAccountId, preJob.lineItems)
      : null;

  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    const job = jobSnap.data() as Job | undefined;
    if (!jobSnap.exists || !job || job.subAccountId !== input.subAccountId) {
      throw new FieldServicesError(`${(await getJobTerms(input.subAccountId)).Job} not found.`, 404);
    }
    if (job.status === "closed" || job.status === "cancelled") {
      throw new FieldServicesError(`A closed or cancelled ${(await getJobTerms(input.subAccountId)).job} can't take new visits.`, 409);
    }
    const existing = await tx.get(db.collection("visits").where("jobId", "==", input.jobId));
    const statuses = existing.docs.map((d) => d.data().status as VisitStatus);

    visitDoc = {
      agencyId: job.agencyId,
      subAccountId: job.subAccountId,
      createdByUid: input.createdByUid,
      territoryId: job.territoryId,
      jobId: input.jobId,
      contactId: job.contactId,
      jobNumber: job.number,
      jobTitle: job.title,
      contactName: job.contactName ?? "",
      address: formatServiceAddress(job.serviceAddress),
      scheduledStart: Timestamp.fromDate(start),
      scheduledEnd: Timestamp.fromDate(end),
      anytime,
      arrivalWindow: null,
      workerIds,
      travelMinutes: allowance.travel,
      ...(input.autoScheduled === true ? { autoScheduled: true } : {}),
      serviceLineIds: [],
      status: "pending",
      notes: typeof input.notes === "string" ? input.notes.trim().slice(0, 2_000) : "",
      photos: [],
      ...(checklist ?? {}),
      reminderVersion: 1,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(visitRef, visitDoc);
    const res = applyJobStatus(tx, jobRef, { ...job, id: jobSnap.id }, [...statuses, "pending"]);
    completedNow = res.completedNow;
    jobAfter = { ...job, id: jobSnap.id, status: res.status };
  });

  const job = jobAfter as unknown as Job;
  const doc = visitDoc as unknown as Omit<Visit, "id">;
  const visit = { ...doc, id: visitRef.id, scheduledStart: start, scheduledEnd: end };
  await recordFieldActivity(
    job.contactId,
    "field_visit",
    `Visit scheduled for ${job.number}.`,
    { jobId: job.id, visitId: visitRef.id },
  );
  announceVisitScheduled(visit as unknown as Visit, job, start);
  runAfterResponse(() => moveDealToWonWhenScheduled(job));
  if (completedNow) announceJobCompleted(job);

  const clash = workerIds.length
    ? await findScheduleClashes({
        subAccountId: input.subAccountId,
        workerIds,
        start,
        end,
        travelMinutes: allowance.travel,
        ignoreVisitId: visitRef.id,
      })
    : { overlap: [], tight: [] };
  const names = new Map(workers.map((w) => [w.id, w.name]));
  const warnings = [
    ...clash.overlap.map((id) => `${names.get(id) ?? "A worker"} already has a visit at that time.`),
    ...clash.tight.map((id) => `${names.get(id) ?? "A worker"} doesn't have enough travel time between this and another visit.`),
    ...(await workerFitWarnings({
      subAccountId: input.subAccountId,
      workers,
      job: preJob && preJob.subAccountId === input.subAccountId ? preJob : undefined,
      start,
      end,
      anytime,
      ignoreVisitId: visitRef.id,
    })),
  ];
  return { id: visitRef.id, warnings };
}

async function loadVisit(subAccountId: string, visitId: string) {
  const ref = getAdminDb().doc(`visits/${visitId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Visit not found.", 404);
  }
  return { ref, data: { id: snap.id, ...snap.data() } as Visit };
}

export async function updateVisit(input: {
  subAccountId: string;
  visitId: string;
  body: Record<string, unknown>;
  /** The route and day planners move visits they were allowed to move, so the system-scheduled mark stays. */
  keepAutoScheduled?: boolean;
}): Promise<{ warnings: string[] }> {
  const { ref, data } = await loadVisit(input.subAccountId, input.visitId);
  if (FINAL.includes(data.status)) {
    throw new FieldServicesError("A finished visit can't be changed.", 409);
  }
  const body = input.body;
  const updates: Record<string, unknown> = {};
  let rescheduled = false;
  const curStart = toDate(data.scheduledStart) ?? new Date();
  const curEnd = toDate(data.scheduledEnd) ?? new Date(curStart.getTime() + 3_600_000);
  let start = curStart;
  let end = curEnd;

  if (body.scheduledStart !== undefined || body.scheduledEnd !== undefined) {
    start = body.scheduledStart !== undefined ? parseDate(body.scheduledStart, "Start") : curStart;
    end = body.scheduledEnd !== undefined ? parseDate(body.scheduledEnd, "End") : new Date(start.getTime() + (curEnd.getTime() - curStart.getTime()));
    if (end <= start) throw new FieldServicesError("The end must be after the start.");
    if (end.getTime() - start.getTime() > 24 * 3_600_000) {
      throw new FieldServicesError("A visit can't run longer than 24 hours.");
    }
    // Only a real change counts as a reschedule.
    if (start.getTime() !== curStart.getTime() || end.getTime() !== curEnd.getTime()) {
      updates.scheduledStart = Timestamp.fromDate(start);
      updates.scheduledEnd = Timestamp.fromDate(end);
      rescheduled = true;
    }
  }
  if (typeof body.anytime === "boolean") updates.anytime = body.anytime;
  let notesChanged = false;
  if (typeof body.notes === "string") {
    updates.notes = body.notes.trim().slice(0, 2_000);
    notesChanged = updates.notes !== (data.notes ?? "");
  }

  let workers: FieldWorker[] | null = null;
  let workersChanged = false;
  if (body.workerIds !== undefined) {
    workers = await resolveWorkers(input.subAccountId, body.workerIds);
    const next = workers.map((w) => w.id);
    workersChanged =
      next.length !== data.workerIds.length || next.some((id) => !data.workerIds.includes(id));
    if (workersChanged) updates.workerIds = next;
  }
  if (Object.keys(updates).length === 0) {
    return { warnings: [] };
  }
  if (rescheduled || workersChanged) updates.reminderVersion = FieldValue.increment(1);
  // Once a person changes the time or the staff, the planners must treat the visit as fixed.
  if ((rescheduled || workersChanged) && !input.keepAutoScheduled && data.autoScheduled) updates.autoScheduled = FieldValue.delete();
  if (data.recurringOf && (rescheduled || workersChanged)) updates.manual = true;
  if (rescheduled) updates.lateAlertedAt = FieldValue.delete();
  if (workersChanged) updates.unassignedAlertedAt = FieldValue.delete();
  updates.updatedAt = FieldValue.serverTimestamp();
  await ref.update(updates);

  if (rescheduled) {
    emitFieldWebhook({
      subAccountId: data.subAccountId,
      agencyId: data.agencyId,
      type: "visit.rescheduled",
      payload: {
        visit: serializeVisit({
          ...data,
          scheduledStart: start,
          scheduledEnd: end,
          workerIds: (updates.workerIds as string[] | undefined) ?? data.workerIds,
        }),
      },
    });
    await recordFieldActivity(data.contactId, "field_visit", "Visit rescheduled.", {
      jobId: data.jobId,
      visitId: data.id,
    });
  }
  if (rescheduled || workersChanged) {
    const nextVersion = (data.reminderVersion ?? 1) + 1;
    runAfterResponse(async () => {
      const jobDoc = (await getAdminDb().doc(`jobs/${data.jobId}`).get()).data();
      if (rescheduled) await sendVisitMessage("scheduled", data.id);
      const nextIds = (updates.workerIds as string[] | undefined) ?? data.workerIds;
      const added = nextIds.filter((id) => !data.workerIds.includes(id));
      const removed = data.workerIds.filter((id) => !nextIds.includes(id));
      const kept = nextIds.filter((id) => data.workerIds.includes(id));
      await stopTimersForWorkers(data.subAccountId, data.id, removed).catch(() => {});
      await scheduleVisitReminder({
        id: data.id,
        scheduledStart: start,
        reminderVersion: nextVersion,
        timezone: (jobDoc?.timezone as string | undefined) ?? "UTC",
      });
      await notifyCrew({ visitId: data.id, workerIds: added, kind: "assigned" });
      await notifyCrew({ visitId: data.id, workerIds: removed, kind: "unassigned" });
      if (rescheduled) await notifyCrew({ visitId: data.id, workerIds: kept, kind: "rescheduled" });
    });
  }

  const ids = (updates.workerIds as string[] | undefined) ?? data.workerIds;
  if (notesChanged && !rescheduled) {
    // Anyone newly added got the assigned notice already.
    const stayed = ids.filter((id) => data.workerIds.includes(id));
    runAfterResponse(() => notifyCrew({ visitId: data.id, workerIds: stayed, kind: "updated", detail: "Notes changed" }));
  }
  const clash = ids.length
    ? await findScheduleClashes({
        subAccountId: input.subAccountId,
        workerIds: ids,
        start,
        end,
        travelMinutes: data.travelMinutes,
        ignoreVisitId: data.id,
      })
    : { overlap: [], tight: [] };
  const names = new Map((workers ?? []).map((w) => [w.id, w.name]));
  const fitWorkers = workers ?? (ids.length ? await resolveWorkers(input.subAccountId, ids).catch(() => []) : []);
  const jobNow = (await getAdminDb().doc(`jobs/${data.jobId}`).get()).data() as Job | undefined;
  return {
    warnings: [
      ...clash.overlap.map((id) => `${names.get(id) ?? "A worker"} already has a visit at that time.`),
      ...clash.tight.map((id) => `${names.get(id) ?? "A worker"} doesn't have enough travel time between this and another visit.`),
      ...(await workerFitWarnings({
        subAccountId: input.subAccountId,
        workers: fitWorkers,
        job: jobNow && jobNow.subAccountId === input.subAccountId ? jobNow : undefined,
        start,
        end,
        anytime: typeof body.anytime === "boolean" ? body.anytime : data.anytime === true,
        ignoreVisitId: data.id,
      })),
    ],
  };
}

export async function setVisitStatus(input: {
  subAccountId: string;
  visitId: string;
  status: string;
  actorUid: string;
  isOffice: boolean;
  workerId?: string | null;
}): Promise<void> {
  const db = getAdminDb();
  const next = input.status as VisitStatus;
  if (!(next in TRANSITIONS) || next === "pending") {
    throw new FieldServicesError("Unknown visit status.");
  }
  const { ref, data } = await loadVisit(input.subAccountId, input.visitId);

  if (!input.isOffice) {
    const mine = input.workerId ?? (await workerForUid(input.subAccountId, input.actorUid));
    if (!mine || !data.workerIds.includes(mine)) {
      throw new FieldServicesError("You can only update visits you are assigned to.", 403);
    }
    if (next === "cancelled") {
      throw new FieldServicesError("Only the office can cancel a visit.", 403);
    }
  }

  const jobRef = db.doc(`jobs/${data.jobId}`);
  let jobAfter: Job | null = null;
  let completedNow = false;
  let changed = false;
  let current: VisitStatus = data.status;

  await db.runTransaction(async (tx) => {
    changed = false;
    completedNow = false;
    const [visitSnap, jobSnap] = await Promise.all([tx.get(ref), tx.get(jobRef)]);
    const live = visitSnap.data() as Visit | undefined;
    const job = jobSnap.data() as Job | undefined;
    if (!live || !job) throw new FieldServicesError("Visit not found.", 404);
    current = live.status;
    if (current === next) return;
    if (!TRANSITIONS[current].includes(next)) {
      throw new FieldServicesError(`A visit that is ${STATUS_TEXT[current]} can't be ${STATUS_TEXT[next]}.`, 409);
    }
    if (job.status === "closed" || job.status === "cancelled") {
      throw new FieldServicesError(`This ${(await getJobTerms(input.subAccountId)).job} is closed.`, 409);
    }
    if (next === "completed" && !input.isOffice) {
      const left = requiredLeft(live);
      if (live.requireChecklist && left > 0) {
        throw new FieldServicesError(
          `Finish the checklist first. ${left} required item${left === 1 ? "" : "s"} left.`,
          409,
        );
      }
      if (live.requireSignature && live.signoff?.status !== "signed") {
        throw new FieldServicesError("The customer needs to sign off before you can complete this visit.", 409);
      }
    }
    const all = await tx.get(db.collection("visits").where("jobId", "==", data.jobId));
    const statuses = all.docs.map((d) => (d.id === ref.id ? next : (d.data().status as VisitStatus)));

    const patch: Record<string, unknown> = {
      status: next,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (next === "on_my_way") patch.onMyWayAt = FieldValue.serverTimestamp();
    if (next === "checked_in") patch.checkedInAt = FieldValue.serverTimestamp();
    if (next === "completed") patch.completedAt = FieldValue.serverTimestamp();
    if (next === "cancelled") patch.reminderVersion = FieldValue.increment(1);
    tx.update(ref, patch);
    const res = applyJobStatus(tx, jobRef, { ...job, id: jobSnap.id }, statuses);
    completedNow = res.completedNow;
    jobAfter = { ...job, id: jobSnap.id, status: res.status };
    changed = true;
  });

  if (!changed) return;
  const job = jobAfter as unknown as Job;
  const visit = { ...data, status: next } as Visit;
  await recordFieldActivity(
    data.contactId,
    "field_visit",
    `Visit for ${job.number} ${STATUS_TEXT[next]}.`,
    { jobId: data.jobId, visitId: data.id },
  );
  const event = STATUS_EVENT[next];
  if (event) {
    emitFieldWebhook({
      subAccountId: data.subAccountId,
      agencyId: data.agencyId,
      type: event,
      payload: { visit: serializeVisit({ ...visit, [`${next}At`]: new Date() } as Visit) },
    });
  }
  const trigger = STATUS_TRIGGER[next];
  if (trigger) {
    fireFieldTrigger({
      subAccountId: data.subAccountId,
      agencyId: data.agencyId,
      type: trigger,
      contactId: data.contactId,
      context: { jobId: data.jobId, visitId: data.id, workerIds: data.workerIds },
    });
  }
  if (completedNow) announceJobCompleted(job);
  if (next === "on_my_way" || next === "completed") {
    const kind = next;
    runAfterResponse(() => sendVisitMessage(kind, data.id));
  }
  if (next === "cancelled") {
    runAfterResponse(() => notifyCrew({ visitId: data.id, workerIds: data.workerIds, kind: "cancelled" }));
    if (data.recurringOf && data.occurrenceDate) {
      await db
        .doc(`jobs/${data.recurringOf}`)
        .update({ "recurrence.skipped": FieldValue.arrayUnion(data.occurrenceDate) })
        .catch((err) => console.warn("[field-visits] couldn't record the skipped repeat date", err));
    }
  }

  if (next === "no_show" || next === "cancelled") {
    await cancelPendingSignoffsForVisit(data.id).catch(() => {});
  }

  if (next === "completed" || next === "no_show" || next === "cancelled") {
    const stop =
      next !== "completed" || (await getFieldServicesConfig(data.subAccountId)).timerStopOnComplete;
    if (stop) {
      await stopTimersForVisit(data.subAccountId, data.id).catch((err) =>
        console.warn("[field-visits] stopping timers failed", err),
      );
    }
  }
}

export async function countUpcomingForWorker(
  subAccountId: string,
  workerId: string,
): Promise<number> {
  const snap = await getAdminDb()
    .collection("visits")
    .where("subAccountId", "==", subAccountId)
    .where("workerIds", "array-contains", workerId)
    .get();
  return snap.docs.filter((d) => !FINAL.includes(d.data().status as VisitStatus)).length;
}

export async function reassignWorkerVisits(input: {
  subAccountId: string;
  fromWorkerId: string;
  toWorkerId: string | null;
}): Promise<number> {
  if (input.toWorkerId === input.fromWorkerId) {
    throw new FieldServicesError("Choose a different worker to take the visits.");
  }
  if (input.toWorkerId) {
    await resolveWorkers(input.subAccountId, [input.toWorkerId]);
  }
  const db = getAdminDb();
  const snap = await db
    .collection("visits")
    .where("subAccountId", "==", input.subAccountId)
    .where("workerIds", "array-contains", input.fromWorkerId)
    .get();
  const open = snap.docs.filter((d) => !FINAL.includes(d.data().status as VisitStatus));
  const reminders = open
    .filter((d) => d.data().status === "pending")
    .map((d) => ({
      id: d.id,
      jobId: d.data().jobId as string,
      start: (d.data().scheduledStart as { toDate?: () => Date } | null)?.toDate?.() ?? null,
      version: ((d.data().reminderVersion as number | undefined) ?? 1) + 1,
    }));
  for (let i = 0; i < open.length; i += 400) {
    const batch = db.batch();
    for (const d of open.slice(i, i + 400)) {
      const ids = (d.data().workerIds as string[]).filter((w) => w !== input.fromWorkerId);
      if (input.toWorkerId && !ids.includes(input.toWorkerId)) ids.push(input.toWorkerId);
      batch.update(d.ref, {
        workerIds: ids,
        reminderVersion: FieldValue.increment(1),
        unassignedAlertedAt: FieldValue.delete(),
        ...(d.data().recurringOf ? { manual: true } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  const zones = new Map<string, string>();
  for (const r of reminders) {
    if (!r.start) continue;
    if (!zones.has(r.jobId)) {
      const job = (await db.doc(`jobs/${r.jobId}`).get()).data();
      zones.set(r.jobId, (job?.timezone as string | undefined) ?? "UTC");
    }
    await scheduleVisitReminder({
      id: r.id,
      scheduledStart: r.start,
      reminderVersion: r.version,
      timezone: zones.get(r.jobId)!,
    }).catch((err) => console.warn("[field-visits] reminder reschedule failed", err));
  }
  for (const d of open) {
    await stopTimersForWorkers(input.subAccountId, d.id, [input.fromWorkerId]).catch(() => {});
  }
  const target = input.toWorkerId;
  runAfterResponse(async () => {
    for (const d of open.slice(0, 20)) {
      await notifyCrew({ visitId: d.id, workerIds: [input.fromWorkerId], kind: "unassigned" });
      if (target) await notifyCrew({ visitId: d.id, workerIds: [target], kind: "assigned" });
    }
  });
  return open.length;
}

/** Creates one visit of a repeating job. Safe to call twice: the id is fixed per date. Returns false if it already existed. */
export async function createGeneratedVisit(input: {
  job: Job;
  date: string;
  start: Date;
  end: Date;
  workerIds: string[];
  /** The schedule fingerprint this run started with; a changed schedule aborts the create. */
  sig?: string;
  notes?: string;
}): Promise<boolean> {
  const db = getAdminDb();
  const jobRef = db.doc(`jobs/${input.job.id}`);
  const visitRef = db.doc(`visits/rec_${input.job.id}_${input.date.replace(/-/g, "")}`);
  let created = false;
  const checklist = await seedVisitChecklist(input.job.subAccountId, input.job.lineItems);
  const travel = (await jobAllowance(input.job.subAccountId, input.job.id)).travel;

  await db.runTransaction(async (tx) => {
    created = false;
    const [existing, jobSnap] = await Promise.all([tx.get(visitRef), tx.get(jobRef)]);
    const job = jobSnap.data() as Job | undefined;
    if (existing.exists) return;
    if (!job || job.status === "closed" || job.status === "cancelled" || job.recurrence?.active !== true) return;
    if (input.sig !== undefined && job.recurrence.sig !== input.sig) return;
    tx.set(visitRef, {
      agencyId: job.agencyId,
      subAccountId: job.subAccountId,
      createdByUid: "recurring",
      territoryId: job.territoryId,
      jobId: input.job.id,
      contactId: job.contactId,
      jobNumber: job.number,
      jobTitle: job.title,
      contactName: job.contactName ?? "",
      address: formatServiceAddress(job.serviceAddress),
      scheduledStart: Timestamp.fromDate(input.start),
      scheduledEnd: Timestamp.fromDate(input.end),
      anytime: false,
      arrivalWindow: null,
      workerIds: input.workerIds,
      travelMinutes: travel,
      serviceLineIds: [],
      status: "pending",
      notes: (input.notes ?? "").slice(0, 2_000),
      photos: [],
      ...(checklist ?? {}),
      recurringOf: input.job.id,
      occurrenceDate: input.date,
      manual: false,
      // A fresh number each time, so a reminder queued for an earlier copy of this date never matches.
      reminderVersion: Math.floor(Date.now() / 1000),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (job.status === "unscheduled" || job.status === "action_required" || job.status === "ready_to_invoice") {
      tx.update(jobRef, { status: "scheduled", updatedAt: FieldValue.serverTimestamp() });
    }
    created = true;
  });
  if (!created) return false;

  const visit = {
    id: visitRef.id,
    agencyId: input.job.agencyId,
    subAccountId: input.job.subAccountId,
    jobId: input.job.id,
    contactId: input.job.contactId,
    scheduledStart: input.start,
    scheduledEnd: input.end,
    workerIds: input.workerIds,
    status: "pending",
  };
  emitFieldWebhook({
    subAccountId: input.job.subAccountId,
    agencyId: input.job.agencyId,
    type: "visit.scheduled",
    payload: { visit: serializeVisit(visit as unknown as Visit), generated: true },
  });
  fireFieldTrigger({
    subAccountId: input.job.subAccountId,
    agencyId: input.job.agencyId,
    type: "visit.scheduled",
    contactId: input.job.contactId,
    context: { jobId: input.job.id, visitId: visitRef.id, workerIds: input.workerIds, generated: true },
  });
  const soon = input.start.getTime() - Date.now() < 48 * 3_600_000;
  if (soon) {
    runAfterResponse(() => notifyCrew({ visitId: visitRef.id, workerIds: input.workerIds, kind: "assigned" }));
  }
  return true;
}

/** Re-derives a job's status from its visits, for when visits were removed outside a normal status change. */
export async function recomputeJobStatus(jobId: string): Promise<void> {
  const db = getAdminDb();
  const jobRef = db.doc(`jobs/${jobId}`);
  let completed: Job | null = null;
  await db.runTransaction(async (tx) => {
    completed = null;
    const jobSnap = await tx.get(jobRef);
    const job = jobSnap.data() as Job | undefined;
    if (!job) return;
    const visits = await tx.get(db.collection("visits").where("jobId", "==", jobId));
    const res = applyJobStatus(
      tx,
      jobRef,
      { ...job, id: jobSnap.id },
      visits.docs.map((d) => d.data().status as VisitStatus),
    );
    if (res.completedNow) completed = { ...job, id: jobSnap.id, status: res.status };
  });
  if (completed) announceJobCompleted(completed);
}
