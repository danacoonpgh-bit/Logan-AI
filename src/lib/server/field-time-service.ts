import "server-only";

import { DEFAULT_TIME_KINDS, projectActivities } from "@/lib/field-services/time-kinds";
import { FieldPath, FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  assertCanActOnVisit,
  type FieldActor,
} from "@/lib/server/field-access";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { existingInvoiceIds } from "@/lib/server/field-invoicing";
import { assertWeekEditable, workspaceTimezone } from "@/lib/server/field-timesheet-service";
import { isDayKey, unionMs, type Span } from "@/lib/field-services/intervals";
import { jobTerms } from "@/lib/field-services/terms";
import { addDaysToKey, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import {
  loadInternalJob,
  workerMayUseInternalJob,
} from "@/lib/server/field-internal-jobs-service";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import type { FieldServicesConfig, Job, TimeEntry, Visit } from "@/types/field-services";

const OPEN_VISIT = ["pending", "on_my_way", "checked_in"];

/** What a time entry that is not on a visit can be called. Break and general time may belong to no job. */
export type JobTimeKind = string;

/** The workspace's kind of time with this id, if it is still in use. */
async function activeKind(subAccountId: string, id: string) {
  const config = await getFieldServicesConfig(subAccountId);
  const def = (config.timeKinds ?? DEFAULT_TIME_KINDS).find((k) => k.id === id && !k.archived);
  if (!def) throw new FieldServicesError("Choose what kind of time this is.");
  return def;
}

export type TimeTarget =
  | { type: "visit"; visitId: string }
  | { type: "job"; jobId: string; kind: JobTimeKind }
  | { type: "internal"; internalJobId: string; kind: JobTimeKind }
  | { type: "none"; kind: "general" | "break" };

const MAX_ENTRY_HOURS = 24;
const STALE_SWEEP_PAGE = 300;
const STALE_SWEEP_PAGES = 20;
const FUTURE_SLACK_MS = 5 * 60_000;
const WORKER_BACKDATE_DAYS = 62;

function toDate(v: unknown): Date | null {
  const t = v as { toDate?: () => Date } | null | undefined;
  return t && typeof t.toDate === "function" ? t.toDate() : null;
}

const ID = /^[A-Za-z0-9_-]{6,80}$/;

function validId(v: unknown): v is string {
  return typeof v === "string" && ID.test(v);
}

async function loadVisit(subAccountId: string, visitId: unknown) {
  if (!validId(visitId)) throw new FieldServicesError("Visit not found.", 404);
  const snap = await getAdminDb().doc(`visits/${visitId}`).get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Visit not found.", 404);
  }
  return { id: snap.id, ...snap.data() } as Visit;
}

async function jobWords(subAccountId: string) {
  return jobTerms(await getFieldServicesConfig(subAccountId));
}

async function loadJob(subAccountId: string, jobId: unknown) {
  if (!validId(jobId)) throw new FieldServicesError(`${(await jobWords(subAccountId)).Job} not found.`, 404);
  const snap = await getAdminDb().doc(`jobs/${jobId}`).get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError(`${(await jobWords(subAccountId)).Job} not found.`, 404);
  }
  return { id: snap.id, ...snap.data() } as Job;
}

async function loadActiveWorker(subAccountId: string, workerId: unknown): Promise<{ agencyId: string }> {
  if (!validId(workerId)) throw new FieldServicesError("Worker not found.", 404);
  const snap = await getAdminDb().doc(`fieldWorkers/${workerId}`).get();
  const w = snap.data();
  if (!snap.exists || !w || w.subAccountId !== subAccountId || w.status !== "active") {
    throw new FieldServicesError("Worker not found.", 404);
  }
  return { agencyId: w.agencyId as string };
}

/** Remembers the worker logged time just now, so the weekly reminder knows who to nudge. */
async function markWorkerActive(subAccountId: string, workerId: string, agencyId: string): Promise<void> {
  try {
    await getAdminDb()
      .doc(`fieldWorkdays/${workerId}`)
      .set({ agencyId, subAccountId, workerId, lastEntryAt: FieldValue.serverTimestamp() }, { merge: true });
  } catch (err) {
    console.warn("[field-time] could not note activity", err);
  }
}

async function requireTimesheets(subAccountId: string): Promise<FieldServicesConfig> {
  const config = await getFieldServicesConfig(subAccountId);
  if (!config.timesheetsEnabled) {
    throw new FieldServicesError("Timesheets are switched off for this workspace.", 409);
  }
  return config;
}

/** A worker's logged time on one local day with overlap counted once, optionally with one more range added. */
async function dayTotalMs(input: {
  subAccountId: string;
  workerId: string;
  dayKey: string;
  tz: string;
  extra?: Span;
  exceptId?: string;
}): Promise<number> {
  const db = getAdminDb();
  const from = zonedTimeToUtc(`${input.dayKey}T00:00`, input.tz);
  const to = zonedTimeToUtc(`${addDaysToKey(input.dayKey, 1)}T00:00`, input.tz);
  let docs;
  try {
    docs = (
      await db
        .collection("timeEntries")
        .where("subAccountId", "==", input.subAccountId)
        .where("workerId", "==", input.workerId)
        .where("startAt", ">=", Timestamp.fromDate(from))
        .where("startAt", "<", Timestamp.fromDate(to))
        .get()
    ).docs;
  } catch {
    docs = (await db.collection("timeEntries").where("workerId", "==", input.workerId).get()).docs.filter((d) => {
      const st = toDate(d.data().startAt)?.getTime() ?? 0;
      return d.data().subAccountId === input.subAccountId && st >= from.getTime() && st < to.getTime();
    });
  }
  const now = Date.now();
  const spans: Span[] = [];
  for (const d of docs) {
    const e = d.data();
    if (d.id === input.exceptId || e.voided === true) continue;
    const a = toDate(e.startAt)?.getTime();
    const b = e.running === true ? now : toDate(e.endAt)?.getTime();
    if (a !== undefined && b !== undefined && b > a) spans.push([a, b, e.hoursOnly === true]);
  }
  if (input.extra) spans.push(input.extra);
  return unionMs(spans);
}

async function assertUnderDayLimit(input: {
  subAccountId: string;
  workerId: string;
  config: FieldServicesConfig;
  start: Date;
  end?: Date;
  /** The new time is hours only, so it adds to the day instead of overlapping. */
  fixed?: boolean;
  exceptId?: string;
}): Promise<void> {
  const maxMs = (input.config.maxDayHours ?? 10) * 3_600_000;
  const tz = await workspaceTimezone(input.subAccountId);
  const dayKey = zonedDateKey(input.start, tz);
  const total = await dayTotalMs({
    subAccountId: input.subAccountId,
    workerId: input.workerId,
    dayKey,
    tz,
    extra: input.end ? [input.start.getTime(), input.end.getTime(), input.fixed === true] : undefined,
    exceptId: input.exceptId,
  });
  const growing =
    input.end && input.exceptId
      ? total > (await dayTotalMs({ subAccountId: input.subAccountId, workerId: input.workerId, dayKey, tz }))
      : true;
  if (growing && (input.end ? total > maxMs : total >= maxMs)) {
    throw new FieldServicesError(
      `That is over the ${input.config.maxDayHours}-hour limit for a day. Ask the office to add it.`,
      409,
    );
  }
}

/** A timer that ran for less than the workspace minimum is thrown away, like a stray tap. */
async function dropShortTimers(refs: DocumentReference[], minMs: number): Promise<void> {
  if (minMs <= 0) return;
  for (const ref of refs) {
    try {
      const snap = await ref.get();
      const d = snap.data() as (TimeEntry & { invoicedAt?: unknown }) | undefined;
      if (!d || d.running || d.voided === true || d.invoicedAt || isDayTimer(d)) continue;
      const a = toDate(d.startAt)?.getTime();
      const b = toDate(d.endAt)?.getTime();
      if (a === undefined || b === undefined || b - a >= minMs) continue;
      await ref.update({ voided: true, updatedAt: FieldValue.serverTimestamp() });
      await ref.collection("revisions").add({
        byUid: "system",
        at: FieldValue.serverTimestamp(),
        reason: "Shorter than the minimum entry",
        before: { voided: false },
        after: { voided: true },
      });
    } catch (err) {
      console.warn("[field-time] could not drop a short timer", err);
    }
  }
}

/** A worker may book time and expenses to a job only while assigned to one of its visits. */
export async function workerMayBookJob(
  subAccountId: string,
  workerId: string,
  job: Pick<Job, "id">,
): Promise<boolean> {
  const visits = await getAdminDb().collection("visits").where("jobId", "==", job.id).get();
  return visits.docs.some(
    (d) =>
      d.data().subAccountId === subAccountId &&
      ((d.data().workerIds as string[] | undefined) ?? []).includes(workerId),
  );
}

interface Resolved {
  agencyId: string;
  territoryId: string | null;
  jobId: string | null;
  visitId: string | null;
  internalJobId: string | null;
  kind: TimeEntry["kind"];
  billable: boolean;
  /** The project records hours only, with no start and stop times. */
  hoursOnly: boolean;
}

function isDayTimer(e: { kind?: unknown; jobId?: unknown; visitId?: unknown; internalJobId?: unknown }): boolean {
  return e.kind === "general" && !e.jobId && !e.visitId && !e.internalJobId;
}

function pickWorkerId(actor: FieldActor, requested?: unknown): string {
  const workerId = actor.isOffice && requested ? requested : actor.workerId;
  if (!workerId) {
    throw new FieldServicesError("Only a worker with a profile can log time.", 403);
  }
  if (!validId(workerId)) throw new FieldServicesError("Worker not found.", 404);
  return workerId;
}

async function resolveTarget(input: {
  subAccountId: string;
  actor: FieldActor;
  workerId: string;
  target: TimeTarget;
  /** A timer needs open work; adding missed time may go on finished visits. */
  forTimer: boolean;
}): Promise<Resolved> {
  const { subAccountId, actor, workerId, target } = input;
  if (!target || !["visit", "job", "internal", "none"].includes((target as { type?: string }).type ?? "")) {
    throw new FieldServicesError("Choose where this time goes.");
  }
  const worker = await loadActiveWorker(subAccountId, workerId);
  const strict = input.forTimer || !actor.isOffice;

  if (target.type === "visit") {
    const visit = await loadVisit(subAccountId, target.visitId);
    assertCanActOnVisit(actor, visit);
    if (input.forTimer && !OPEN_VISIT.includes(visit.status)) {
      throw new FieldServicesError("This visit is already finished.", 409);
    }
    if (!visit.workerIds.includes(workerId)) {
      throw new FieldServicesError("That worker isn't on this visit.", 400);
    }
    if (!input.forTimer && visit.invoiceId && (await existingInvoiceIds([visit.invoiceId])).size > 0) {
      throw new FieldServicesError(
        `That visit is already on an invoice. Add the time to the ${(await jobWords(subAccountId)).job} instead and it goes on the next one.`,
        409,
      );
    }
    if (!actor.isOffice) {
      const job = await loadJob(subAccountId, visit.jobId);
      if (visit.status === "cancelled" || job.status === "closed" || job.status === "cancelled") {
        throw new FieldServicesError(`This ${(await jobWords(subAccountId)).job} is closed.`, 409);
      }
    }
    return {
      agencyId: visit.agencyId,
      territoryId: visit.territoryId,
      jobId: visit.jobId,
      visitId: visit.id,
      internalJobId: null,
      kind: "visit",
      billable: true,
      hoursOnly: (await loadJob(subAccountId, visit.jobId)).hoursOnly === true,
    };
  }

  if (target.type === "job") {
    const kindDef = await activeKind(subAccountId, target.kind);
    const job = await loadJob(subAccountId, target.jobId);
    if (strict && (job.status === "closed" || job.status === "cancelled")) {
      throw new FieldServicesError(`This ${(await jobWords(subAccountId)).job} is closed.`, 409);
    }
    if (strict && job.activityIds && !projectActivities((await getFieldServicesConfig(subAccountId)).timeKinds, job).some((k) => k.id === target.kind)) {
      // A row already worked under an activity that was later taken off the project can still take more days.
      const mine = await getAdminDb().collection("timeEntries").where("jobId", "==", job.id).where("workerId", "==", workerId).get();
      if (!mine.docs.some((d) => d.data().kind === target.kind)) {
        throw new FieldServicesError(`${kindDef.label} isn't an activity on this ${(await jobWords(subAccountId)).job}.`, 409);
      }
    }
    if (!actor.isOffice && !(await workerMayBookJob(subAccountId, workerId, job))) {
      throw new FieldServicesError(`You can't book time to that ${(await jobWords(subAccountId)).job}.`, 403);
    }
    return {
      agencyId: job.agencyId,
      territoryId: job.territoryId,
      jobId: job.id,
      visitId: null,
      internalJobId: null,
      kind: target.kind,
      // Whether this kind is chargeable by default is the workspace's choice.
      billable: kindDef.billable,
      hoursOnly: job.hoursOnly === true,
    };
  }

  if (target.type === "internal") {
    await activeKind(subAccountId, target.kind);
    const internal = await loadInternalJob(subAccountId, target.internalJobId);
    if (strict && internal.archived) throw new FieldServicesError(`That internal ${(await jobWords(subAccountId)).job} is archived.`, 409);
    if (!actor.isOffice && !workerMayUseInternalJob(internal, workerId)) {
      throw new FieldServicesError("You can't book time to that.", 403);
    }
    return {
      agencyId: worker.agencyId,
      territoryId: null,
      jobId: null,
      visitId: null,
      internalJobId: internal.id,
      kind: target.kind,
      billable: false,
      hoursOnly: false,
    };
  }

  if (target.kind !== "general" && target.kind !== "break") {
    throw new FieldServicesError("Choose what kind of time this is.");
  }
  return {
    agencyId: worker.agencyId,
    territoryId: null,
    jobId: null,
    visitId: null,
    internalJobId: null,
    kind: target.kind,
    billable: false,
    hoursOnly: false,
  };
}

function sameTarget(
  e: { visitId?: unknown; jobId?: unknown; internalJobId?: unknown; kind?: unknown },
  r: Resolved,
): boolean {
  return (
    (e.visitId ?? null) === r.visitId &&
    (e.jobId ?? null) === r.jobId &&
    (e.internalJobId ?? null) === r.internalJobId &&
    e.kind === r.kind
  );
}

function entryDoc(
  r: Resolved,
  subAccountId: string,
  workerId: string,
  extra: {
    startAt: unknown;
    endAt: unknown;
    running: boolean;
    source: "timer" | "manual";
    note: string;
    hours?: { minutes: number; date: string };
  },
): Omit<TimeEntry, "id"> {
  return {
    agencyId: r.agencyId,
    subAccountId,
    territoryId: r.territoryId,
    workerId,
    jobId: r.jobId,
    visitId: r.visitId,
    internalJobId: r.internalJobId,
    startAt: extra.startAt,
    endAt: extra.endAt,
    ...(extra.hours ? { hoursOnly: true, durationMinutes: extra.hours.minutes, workDate: extra.hours.date } : {}),
    running: extra.running,
    kind: r.kind,
    billable: r.billable,
    source: extra.source,
    note: extra.note,
    status: "open",
    voided: false,
    correctionRequest: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  } as Omit<TimeEntry, "id">;
}

function stopFields() {
  return {
    endAt: FieldValue.serverTimestamp(),
    running: false,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** Crew only get a timer where the project says so, and the day clock only when the workspace turns it on. */
async function assertTimerAllowed(subAccountId: string, r: Resolved, dayClock: boolean): Promise<void> {
  const off = "Timers are off here. Enter your hours instead.";
  if (r.hoursOnly) throw new FieldServicesError("This project records hours only. Enter your hours instead.", 409);
  if (r.jobId) {
    const job = await loadJob(subAccountId, r.jobId);
    if (job.timersEnabled !== true) throw new FieldServicesError(off, 409);
    return;
  }
  if (r.internalJobId) {
    const internal = await loadInternalJob(subAccountId, r.internalJobId);
    if (internal.timersEnabled !== true) throw new FieldServicesError(off, 409);
    return;
  }
  if (!dayClock) throw new FieldServicesError("The day clock is off. Enter your hours instead.", 409);
}

/** Starts a timer on a visit, job, internal job or general time. With timesheets on it stops any running timer; off, only one visit timer is allowed. */
export async function startTimeEntry(input: {
  subAccountId: string;
  actor: FieldActor;
  workerId?: string;
  target: TimeTarget;
}): Promise<{ id: string }> {
  const { subAccountId, actor, target } = input;
  const config = await getFieldServicesConfig(subAccountId);
  const timesheetsOn = config.timesheetsEnabled;
  if (target.type !== "visit" && !timesheetsOn) {
    throw new FieldServicesError("Timesheets are switched off for this workspace.", 409);
  }
  const workerId = pickWorkerId(actor, input.workerId);
  const resolved = await resolveTarget({ subAccountId, actor, workerId, target, forTimer: true });
  if (resolved.hoursOnly) throw new FieldServicesError("This project records hours only, so it has no timer.", 409);
  if (!actor.isOffice) await assertTimerAllowed(subAccountId, resolved, config.dayClockEnabled === true);
  if (timesheetsOn && !actor.isOffice && target.type !== "none") {
    const live = await getAdminDb()
      .collection("timeEntries")
      .where("workerId", "==", workerId)
      .where("running", "==", true)
      .get();
    const already = live.docs.some((d) => d.data().subAccountId === subAccountId && sameTarget(d.data(), resolved));
    if (!already) await assertUnderDayLimit({ subAccountId, workerId, config, start: new Date() });
  }
  await assertWeekEditable(subAccountId, workerId, new Date(), { reopenSubmitted: true });

  const db = getAdminDb();
  const ref = db.collection("timeEntries").doc();
  const running = db
    .collection("timeEntries")
    .where("workerId", "==", workerId)
    .where("running", "==", true);

  let stoppedRefs: DocumentReference[] = [];
  const started = await db.runTransaction(async (tx) => {
    stoppedRefs = [];
    const [jobSnap, others] = await Promise.all([
      resolved.jobId ? tx.get(db.doc(`jobs/${resolved.jobId}`)) : Promise.resolve(null),
      tx.get(running),
    ]);
    if (jobSnap) {
      const job = jobSnap.data() as Job | undefined;
      if (!job || job.status === "closed" || job.status === "cancelled") {
        throw new FieldServicesError(`This ${(await jobWords(subAccountId)).job} is closed.`, 409);
      }
    }
    const mine = others.docs.filter((d) => d.data().subAccountId === subAccountId);
    const same = mine.find((d) => sameTarget(d.data(), resolved));
    if (same) return { id: same.id };
    if (mine.length > 0) {
      if (!timesheetsOn) {
        // Timers that are not on a visit only exist from when timesheets were on, so they are replaced.
        const otherVisit = mine.some((d) => !!d.data().visitId);
        if (otherVisit) {
          throw new FieldServicesError(
            "A timer is already running on another visit. Stop it first.",
            409,
          );
        }
      }
      for (const d of mine) tx.update(d.ref, stopFields());
      stoppedRefs = mine.map((d) => d.ref);
    }
    tx.set(
      ref,
      entryDoc(resolved, subAccountId, workerId, {
        startAt: FieldValue.serverTimestamp(),
        endAt: null,
        running: true,
        source: "timer",
        note: "",
      }),
    );
    return { id: ref.id };
  });
  if (timesheetsOn) {
    await markWorkerActive(subAccountId, workerId, resolved.agencyId);
    if (!actor.isOffice) await dropShortTimers(stoppedRefs, (config.minEntryMinutes ?? 10) * 60_000);
  }
  return started;
}

export async function startTimer(input: {
  subAccountId: string;
  visitId: string;
  actor: FieldActor;
  workerId?: string;
}): Promise<{ id: string }> {
  return startTimeEntry({
    subAccountId: input.subAccountId,
    actor: input.actor,
    workerId: input.workerId,
    target: { type: "visit", visitId: input.visitId },
  });
}

async function loadEntry(subAccountId: string, entryId: unknown) {
  if (!validId(entryId)) throw new FieldServicesError("Time entry not found.", 404);
  const ref = getAdminDb().doc(`timeEntries/${entryId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Time entry not found.", 404);
  }
  return { ref, data: { id: snap.id, ...snap.data() } as TimeEntry };
}

async function endWorkday(subAccountId: string, workerId: string): Promise<void> {
  const ref = getAdminDb().doc(`fieldWorkdays/${workerId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId || snap.data()?.active !== true) return;
  await ref.update({ active: false, endedAt: FieldValue.serverTimestamp() });
}

/** Back to general time after a job timer ends, while the worker is clocked in. Never fails the caller. */
export async function resumeDayTimer(subAccountId: string, workerId: string): Promise<void> {
  try {
    const db = getAdminDb();
    if (!(await getFieldServicesConfig(subAccountId)).timesheetsEnabled) return;
    const wdRef = db.doc(`fieldWorkdays/${workerId}`);
    const running = db
      .collection("timeEntries")
      .where("workerId", "==", workerId)
      .where("running", "==", true);
    await db.runTransaction(async (tx) => {
      const [wdSnap, others] = await Promise.all([tx.get(wdRef), tx.get(running)]);
      const wd = wdSnap.data();
      if (!wd || wd.active !== true || wd.subAccountId !== subAccountId) return;
      if (others.docs.some((d) => d.data().subAccountId === subAccountId)) return;
      const resolved: Resolved = {
        agencyId: wd.agencyId as string,
        territoryId: null,
        jobId: null,
        visitId: null,
        internalJobId: null,
        kind: "general",
        billable: false,
        hoursOnly: false,
      };
      tx.set(
        db.collection("timeEntries").doc(),
        entryDoc(resolved, subAccountId, workerId, {
          startAt: FieldValue.serverTimestamp(),
          endAt: null,
          running: true,
          source: "timer",
          note: "",
        }),
      );
    });
  } catch (err) {
    console.warn("[field-time] could not resume the day timer", err);
  }
}

async function finishEntry(
  ref: DocumentReference,
  actor: FieldActor,
): Promise<TimeEntry | null> {
  let stopped: TimeEntry | null = null;
  await getAdminDb().runTransaction(async (tx) => {
    const fresh = (await tx.get(ref)).data() as TimeEntry | undefined;
    if (!fresh) throw new FieldServicesError("Time entry not found.", 404);
    if (!fresh.running) return;
    if (!actor.isOffice && fresh.workerId !== actor.workerId) {
      throw new FieldServicesError("That isn't your timer.", 403);
    }
    tx.update(ref, stopFields());
    stopped = fresh;
  });
  return stopped;
}

/** Stops any running entry. Ending general time ends the day, anything else drops back to general time. */
export async function stopEntry(input: {
  subAccountId: string;
  entryId: string;
  actor: FieldActor;
}): Promise<void> {
  const { ref, data } = await loadEntry(input.subAccountId, input.entryId);
  const stopped = await finishEntry(ref, input.actor);
  if (!stopped) return;
  if (!input.actor.isOffice) {
    const config = await getFieldServicesConfig(input.subAccountId);
    if (config.timesheetsEnabled) await dropShortTimers([ref], (config.minEntryMinutes ?? 10) * 60_000);
  }
  if (isDayTimer(data)) {
    await endWorkday(input.subAccountId, data.workerId).catch((err) =>
      console.warn("[field-time] could not end the day", err),
    );
  } else {
    await resumeDayTimer(input.subAccountId, data.workerId);
  }
}

export async function stopTimer(input: {
  subAccountId: string;
  entryId: string;
  visitId: string;
  actor: FieldActor;
}): Promise<void> {
  const { data } = await loadEntry(input.subAccountId, input.entryId);
  if (data.visitId !== input.visitId) {
    throw new FieldServicesError("That timer isn't on this visit.", 400);
  }
  await stopEntry({ subAccountId: input.subAccountId, entryId: input.entryId, actor: input.actor });
}

export async function clockIn(input: {
  subAccountId: string;
  actor: FieldActor;
  workerId?: string;
}): Promise<{ id: string }> {
  const { subAccountId } = input;
  const clockConfig = await requireTimesheets(subAccountId);
  if (!input.actor.isOffice && clockConfig.dayClockEnabled !== true) {
    throw new FieldServicesError("The day clock is off. Enter your hours instead.", 409);
  }
  const workerId = pickWorkerId(input.actor, input.workerId);
  const worker = await loadActiveWorker(subAccountId, workerId);
  await assertWeekEditable(subAccountId, workerId, new Date(), { reopenSubmitted: true });
  const db = getAdminDb();
  const wdRef = db.doc(`fieldWorkdays/${workerId}`);
  const running = db
    .collection("timeEntries")
    .where("workerId", "==", workerId)
    .where("running", "==", true);

  return db.runTransaction(async (tx) => {
    const [wdSnap, others] = await Promise.all([tx.get(wdRef), tx.get(running)]);
    const wd = wdSnap.data();
    const wasActive = wd?.active === true && wd.subAccountId === subAccountId;
    const mine = others.docs.filter((d) => d.data().subAccountId === subAccountId);
    if (!wasActive) {
      tx.set(
        wdRef,
        {
          agencyId: worker.agencyId,
          subAccountId,
          workerId,
          active: true,
          startedAt: FieldValue.serverTimestamp(),
          endedAt: FieldValue.delete(),
          lastEntryAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    if (mine.length > 0) return { id: mine[0].id };
    const ref = db.collection("timeEntries").doc();
    tx.set(
      ref,
      entryDoc(
        {
          agencyId: worker.agencyId,
          territoryId: null,
          jobId: null,
          visitId: null,
          internalJobId: null,
          kind: "general",
          billable: false,
          hoursOnly: false,
        },
        subAccountId,
        workerId,
        { startAt: FieldValue.serverTimestamp(), endAt: null, running: true, source: "timer", note: "" },
      ),
    );
    return { id: ref.id };
  });
}

export async function clockOut(input: {
  subAccountId: string;
  actor: FieldActor;
  workerId?: string;
}): Promise<void> {
  const { subAccountId } = input;
  const workerId = pickWorkerId(input.actor, input.workerId);
  await loadActiveWorker(subAccountId, workerId);
  // With timesheets off there are no day timers, so only close a day left over from before.
  if (!(await getFieldServicesConfig(subAccountId)).timesheetsEnabled) {
    await endWorkday(subAccountId, workerId);
    return;
  }
  const db = getAdminDb();
  const wdRef = db.doc(`fieldWorkdays/${workerId}`);
  const running = db
    .collection("timeEntries")
    .where("workerId", "==", workerId)
    .where("running", "==", true);
  await db.runTransaction(async (tx) => {
    const [wdSnap, others] = await Promise.all([tx.get(wdRef), tx.get(running)]);
    for (const d of others.docs) {
      if (d.data().subAccountId === subAccountId) tx.update(d.ref, stopFields());
    }
    const wd = wdSnap.data();
    if (wd && wd.subAccountId === subAccountId && wd.active === true) {
      tx.update(wdRef, { active: false, endedAt: FieldValue.serverTimestamp() });
    }
  });
}

export async function getWorkday(
  subAccountId: string,
  workerId: string,
): Promise<{ active: boolean; startedAt: string | null }> {
  if (!validId(workerId)) return { active: false, startedAt: null };
  const wd = (await getAdminDb().doc(`fieldWorkdays/${workerId}`).get()).data();
  if (!wd || wd.subAccountId !== subAccountId || wd.active !== true) {
    return { active: false, startedAt: null };
  }
  return { active: true, startedAt: toDate(wd.startedAt)?.toISOString() ?? null };
}

export async function stopTimersForWorkers(
  subAccountId: string,
  visitId: string,
  workerIds: string[],
): Promise<void> {
  if (workerIds.length === 0) return;
  const snap = await getAdminDb()
    .collection("timeEntries")
    .where("visitId", "==", visitId)
    .where("running", "==", true)
    .get();
  const mine = snap.docs.filter(
    (d) => d.data().subAccountId === subAccountId && workerIds.includes(d.data().workerId as string),
  );
  if (mine.length === 0) return;
  const batch = getAdminDb().batch();
  for (const d of mine) batch.update(d.ref, stopFields());
  await batch.commit();
  for (const w of new Set(mine.map((d) => d.data().workerId as string))) {
    await resumeDayTimer(subAccountId, w);
  }
}

export async function stopRunningTimersForWorker(subAccountId: string, workerId: string): Promise<void> {
  const db = getAdminDb();
  const snap = await db
    .collection("timeEntries")
    .where("workerId", "==", workerId)
    .where("running", "==", true)
    .get();
  const mine = snap.docs.filter((d) => d.data().subAccountId === subAccountId);
  if (mine.length > 0) {
    const batch = db.batch();
    for (const d of mine) batch.update(d.ref, stopFields());
    await batch.commit();
  }
  await endWorkday(subAccountId, workerId);
}

async function stopRunningWhere(
  subAccountId: string,
  field: "jobId" | "internalJobId",
  id: string,
): Promise<void> {
  const db = getAdminDb();
  const snap = await db.collection("timeEntries").where(field, "==", id).where("running", "==", true).get();
  const mine = snap.docs.filter((d) => d.data().subAccountId === subAccountId);
  if (mine.length === 0) return;
  const batch = db.batch();
  for (const d of mine) batch.update(d.ref, stopFields());
  await batch.commit();
  for (const w of new Set(mine.map((d) => d.data().workerId as string))) {
    await resumeDayTimer(subAccountId, w);
  }
}

/** Closing or cancelling a job also ends timers on it that have no visit. */
export async function stopTimersForJob(subAccountId: string, jobId: string): Promise<void> {
  await stopRunningWhere(subAccountId, "jobId", jobId);
}

export async function stopTimersForInternalJob(subAccountId: string, internalJobId: string): Promise<void> {
  await stopRunningWhere(subAccountId, "internalJobId", internalJobId);
}

export async function stopTimersForVisit(subAccountId: string, visitId: string): Promise<void> {
  const db = getAdminDb();
  const snap = await db
    .collection("timeEntries")
    .where("visitId", "==", visitId)
    .where("running", "==", true)
    .get();
  const mine = snap.docs.filter((d) => d.data().subAccountId === subAccountId);
  if (mine.length === 0) return;
  const batch = db.batch();
  for (const d of mine) batch.update(d.ref, stopFields());
  await batch.commit();
  for (const w of new Set(mine.map((d) => d.data().workerId as string))) {
    await resumeDayTimer(subAccountId, w);
  }
}

export async function editTimeEntry(input: {
  subAccountId: string;
  entryId: string;
  actorUid: string;
  reason: string;
  body: {
    startAt?: unknown;
    endAt?: unknown;
    durationMinutes?: unknown;
    billable?: unknown;
    note?: unknown;
    voided?: unknown;
    target?: TimeTarget;
  };
}): Promise<void> {
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) throw new FieldServicesError("Say why you are changing this time entry.");
  const { ref, data: current } = await loadEntry(input.subAccountId, input.entryId);
  await assertWeekEditable(input.subAccountId, current.workerId, toDate(current.startAt) ?? new Date());
  // Moving the time to another project or activity goes through the same checks as adding it.
  let moveTo: Resolved | null = null;
  if (input.body.target) {
    if (input.body.target.type === "visit") throw new FieldServicesError("Choose a project, an internal project or general time.");
    moveTo = await resolveTarget({
      subAccountId: input.subAccountId,
      actor: { uid: input.actorUid, isOffice: true, workerId: null },
      workerId: current.workerId,
      target: input.body.target,
      forTimer: false,
    });
  }

  const patch: Record<string, unknown> = {};
  const parse = (v: unknown, label: string) => {
    const d = typeof v === "string" || typeof v === "number" ? new Date(v) : null;
    if (!d || Number.isNaN(d.getTime())) throw new FieldServicesError(`${label} isn't a valid time.`);
    return d;
  };
  if (current.hoursOnly === true) {
    if (input.body.startAt !== undefined || input.body.endAt !== undefined) {
      throw new FieldServicesError("This entry records hours only.", 409);
    }
    if (input.body.durationMinutes !== undefined) {
      const minutes = cleanMinutes(input.body.durationMinutes);
      const anchor = toDate(current.startAt);
      if (!anchor) throw new FieldServicesError("That entry has no day.", 409);
      patch.endAt = Timestamp.fromMillis(anchor.getTime() + minutes * 60_000);
      patch.durationMinutes = minutes;
    }
  } else if (input.body.durationMinutes !== undefined) {
    throw new FieldServicesError("This entry has a start and an end.", 409);
  }
  if (input.body.startAt !== undefined) patch.startAt = Timestamp.fromDate(parse(input.body.startAt, "Start"));
  if (input.body.endAt !== undefined) {
    patch.endAt = input.body.endAt === null ? null : Timestamp.fromDate(parse(input.body.endAt, "End"));
  }
  if (typeof input.body.billable === "boolean") patch.billable = input.body.billable;
  if (typeof input.body.note === "string") patch.note = input.body.note.trim().slice(0, 500);
  if (typeof input.body.voided === "boolean") patch.voided = input.body.voided;
  if (input.body.voided === false && current.jobId) {
    // Restoring an entry must not put timed work on an hours-only project, or the reverse.
    if (((await loadJob(input.subAccountId, current.jobId)).hoursOnly === true) !== (current.hoursOnly === true)) {
      throw new FieldServicesError("This project now records time the other way, so this entry cannot be restored.", 409);
    }
  }
  if (moveTo && !sameTarget(current, moveTo)) {
    if (moveTo.hoursOnly !== (current.hoursOnly === true)) {
      throw new FieldServicesError(
        current.hoursOnly === true
          ? "Hours-only time can only move to another project that records hours only."
          : "That project records hours only, so timed work can't move there.",
        409,
      );
    }
    patch.agencyId = moveTo.agencyId;
    patch.territoryId = moveTo.territoryId;
    patch.jobId = moveTo.jobId;
    patch.visitId = moveTo.visitId;
    patch.internalJobId = moveTo.internalJobId;
    patch.kind = moveTo.kind;
    // A billable choice made by the office wins; otherwise the new activity decides.
    if (typeof input.body.billable !== "boolean") patch.billable = moveTo.billable;
  }
  if (Object.keys(patch).length === 0) throw new FieldServicesError("Nothing to change.");
  if (patch.startAt) {
    await assertWeekEditable(input.subAccountId, current.workerId, (patch.startAt as Timestamp).toDate());
  }

  const db = getAdminDb();
  let endedRunning: TimeEntry | null = null;
  await db.runTransaction(async (tx) => {
    endedRunning = null;
    const snap = await tx.get(ref);
    const before = snap.data() as TimeEntry | undefined;
    if (!before) throw new FieldServicesError("Time entry not found.", 404);
    const start = (patch.startAt as Timestamp | undefined) ?? (before.startAt as Timestamp);
    const end =
      patch.endAt !== undefined ? (patch.endAt as Timestamp | null) : ((before.endAt as Timestamp | null) ?? null);
    if (end && start && end.toMillis() <= start.toMillis()) {
      throw new FieldServicesError("The end must be after the start.");
    }
    const billed = before as unknown as { invoicedAt?: unknown; invoiceId?: string };
    if (billed.invoicedAt && (!billed.invoiceId || (await tx.get(db.doc(`quotes/${billed.invoiceId}`))).exists)) {
      throw new FieldServicesError("This time is already on an invoice.", 409);
    }
    if (patch.endAt === null && !before.running) {
      throw new FieldServicesError("A finished entry can't be reopened. Add a new one instead.");
    }
    if (before.running && (end || patch.voided === true)) {
      patch.running = false;
      if (!end) patch.endAt = Timestamp.fromDate(new Date());
      endedRunning = before;
    }

    const prior: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) prior[k] = (before as unknown as Record<string, unknown>)[k] ?? null;
    tx.update(ref, { ...patch, correctionRequest: null, updatedAt: FieldValue.serverTimestamp() });
    tx.set(ref.collection("revisions").doc(), {
      byUid: input.actorUid,
      at: FieldValue.serverTimestamp(),
      reason,
      before: prior,
      after: patch,
    });
  });

  // Ending a running timer here must not leave the worker clocked in with nothing running.
  const ended = endedRunning as TimeEntry | null;
  if (ended) {
    if (isDayTimer(ended)) await endWorkday(input.subAccountId, ended.workerId).catch(() => {});
    else await resumeDayTimer(input.subAccountId, ended.workerId);
  }
}

export async function addManualTimeEntry(input: {
  subAccountId: string;
  visitId: string;
  workerId: string;
  startAt: unknown;
  endAt: unknown;
  actorUid: string;
  reason: string;
  note?: string;
}): Promise<{ id: string }> {
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) throw new FieldServicesError("Say why you are adding this time entry.");
  const visit = await loadVisit(input.subAccountId, input.visitId);
  if (!visit.workerIds.includes(input.workerId)) {
    throw new FieldServicesError("That worker isn't on this visit.", 400);
  }
  if ((await loadJob(input.subAccountId, visit.jobId)).hoursOnly === true) {
    throw new FieldServicesError("This project records hours only, so time on it has no start and end.", 409);
  }
  const s = new Date(input.startAt as string);
  const e = new Date(input.endAt as string);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) {
    throw new FieldServicesError("Enter a start and a later end.");
  }
  await assertWeekEditable(input.subAccountId, input.workerId, s);
  const db = getAdminDb();
  const ref = db.collection("timeEntries").doc();
  const batch = db.batch();
  batch.set(ref, {
    agencyId: visit.agencyId,
    subAccountId: visit.subAccountId,
    territoryId: visit.territoryId,
    workerId: input.workerId,
    jobId: visit.jobId,
    visitId: visit.id,
    startAt: Timestamp.fromDate(s),
    endAt: Timestamp.fromDate(e),
    running: false,
    kind: "visit",
    billable: true,
    source: "manual",
    note: (input.note ?? "").trim().slice(0, 500),
    status: "open",
    voided: false,
    correctionRequest: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(ref.collection("revisions").doc(), {
    byUid: input.actorUid,
    at: FieldValue.serverTimestamp(),
    reason,
    before: null,
    after: { startAt: s.toISOString(), endAt: e.toISOString(), source: "manual" },
  });
  await batch.commit();
  return { id: ref.id };
}

function cleanMinutes(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_ENTRY_HOURS * 60) {
    throw new FieldServicesError("Enter hours between 0 and 24.");
  }
  return v;
}

function checkRange(startAt: unknown, endAt: unknown, isOffice: boolean, minMs = 0): { s: Date; e: Date } {
  const parse = (v: unknown) => {
    const d = typeof v === "string" || typeof v === "number" ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  const s = parse(startAt);
  const e = parse(endAt);
  if (!s || !e || e <= s) throw new FieldServicesError("Enter a start and a later end.");
  if (e.getTime() > Date.now() + FUTURE_SLACK_MS) throw new FieldServicesError("That time hasn't happened yet.");
  if ((e.getTime() - s.getTime()) / 3_600_000 > MAX_ENTRY_HOURS) {
    throw new FieldServicesError("An entry can't be longer than 24 hours.");
  }
  if (!isOffice && s.getTime() < Date.now() - WORKER_BACKDATE_DAYS * 86_400_000) {
    throw new FieldServicesError("That is too far back. Ask the office to add it.");
  }
  if (!isOffice && e.getTime() - s.getTime() < minMs) {
    throw new FieldServicesError(`An entry has to be at least ${Math.round(minMs / 60_000)} minutes.`);
  }
  return { s, e };
}

/** A worker fixing or removing their own finished entry. Anything on an invoice stays as it is. */
export async function editOwnTimeEntry(input: {
  subAccountId: string;
  actor: FieldActor;
  entryId: string;
  body: { startAt?: unknown; endAt?: unknown; durationMinutes?: unknown; note?: unknown; void?: unknown; target?: TimeTarget };
}): Promise<void> {
  const { subAccountId, actor } = input;
  const config = await requireTimesheets(subAccountId);
  if (!actor.workerId) throw new FieldServicesError("Only a worker with a profile can log time.", 403);
  const { ref } = await loadEntry(subAccountId, input.entryId);
  const db = getAdminDb();
  // A wrong project or activity is fixed here: the new place goes through the same checks as adding time.
  const moveTo =
    input.body.target && input.body.void !== true
      ? await resolveTarget({ subAccountId, actor, workerId: actor.workerId, target: input.body.target, forTimer: false })
      : null;

  const tzNow = await workspaceTimezone(subAccountId);
  await db.runTransaction(async (tx) => {
    const before = (await tx.get(ref)).data() as TimeEntry | undefined;
    if (!before) throw new FieldServicesError("Time entry not found.", 404);
    if (before.workerId !== actor.workerId) throw new FieldServicesError("That isn't your time entry.", 403);
    if (before.running) throw new FieldServicesError("Stop the timer first.", 409);
    if (before.voided === true) throw new FieldServicesError("That entry was removed.", 409);
    const billed = before as unknown as { invoicedAt?: unknown; invoiceId?: string };
    if (billed.invoicedAt && (!billed.invoiceId || (await tx.get(db.doc(`quotes/${billed.invoiceId}`))).exists)) {
      throw new FieldServicesError("This time is already on an invoice. Ask the office.", 409);
    }

    const startedAt = toDate(before.startAt)?.getTime() ?? 0;
    // Hours-only time belongs to a day, so the limit counts days, the same as when it was added.
    const tooOld =
      before.hoursOnly === true
        ? zonedDateKey(new Date(startedAt), tzNow) < addDaysToKey(zonedDateKey(new Date(), tzNow), -WORKER_BACKDATE_DAYS)
        : startedAt < Date.now() - WORKER_BACKDATE_DAYS * 86_400_000;
    if (tooOld) {
      throw new FieldServicesError("That is too far back. Ask the office.", 409);
    }
    await assertWeekEditable(subAccountId, before.workerId, startedAt);

    const patch: Record<string, unknown> = {};
    let timesChanged = false;
    if (input.body.void === true) {
      patch.voided = true;
    } else {
      if (before.hoursOnly === true) {
        if (input.body.startAt !== undefined || input.body.endAt !== undefined) {
          throw new FieldServicesError("This entry records hours only.", 409);
        }
        if (input.body.durationMinutes !== undefined) {
          const minutes = cleanMinutes(input.body.durationMinutes);
          const s = toDate(before.startAt) as Date;
          const e = new Date(s.getTime() + minutes * 60_000);
          const was = Math.round(((toDate(before.endAt)?.getTime() ?? s.getTime()) - s.getTime()) / 60_000);
          if (minutes !== was) {
            if (minutes < (config.minEntryMinutes ?? 10)) {
              throw new FieldServicesError(`An entry has to be at least ${config.minEntryMinutes ?? 10} minutes.`);
            }
            await assertUnderDayLimit({
              subAccountId,
              workerId: before.workerId,
              config,
              start: s,
              end: e,
              fixed: true,
              exceptId: ref.id,
            });
            patch.endAt = Timestamp.fromDate(e);
            patch.durationMinutes = minutes;
            timesChanged = true;
          }
        }
      } else if (input.body.durationMinutes !== undefined) {
        throw new FieldServicesError("This entry has a start and an end.", 409);
      }
      if (before.hoursOnly !== true && (input.body.startAt !== undefined || input.body.endAt !== undefined)) {
        const newStart = new Date((input.body.startAt ?? toDate(before.startAt)?.getTime()) as string | number).getTime();
        const newEnd = new Date((input.body.endAt ?? toDate(before.endAt)?.getTime()) as string | number).getTime();
        const unchanged =
          newStart === (toDate(before.startAt)?.getTime() ?? NaN) && newEnd === (toDate(before.endAt)?.getTime() ?? NaN);
        const { s, e } = checkRange(
          input.body.startAt ?? toDate(before.startAt)?.getTime(),
          input.body.endAt ?? toDate(before.endAt)?.getTime(),
          false,
          unchanged ? 0 : (config.minEntryMinutes ?? 10) * 60_000,
        );
        await assertWeekEditable(subAccountId, before.workerId, s);
        if (!unchanged) await assertUnderDayLimit({
          subAccountId,
          workerId: before.workerId,
          config,
          start: s,
          end: e,
          exceptId: ref.id,
        });
        if ((await overlappingEntries(subAccountId, before.workerId, s, e, ref.id)) > 0) {
          throw new FieldServicesError(
            "That overlaps time you already logged. Change the times or edit the other entry.",
            409,
          );
        }
        patch.startAt = Timestamp.fromDate(s);
        patch.endAt = Timestamp.fromDate(e);
        timesChanged = true;
      }
      if (typeof input.body.note === "string") patch.note = input.body.note.trim().slice(0, 500);
      if (moveTo && !sameTarget(before, moveTo)) {
        if (moveTo.hoursOnly !== (before.hoursOnly === true)) {
          throw new FieldServicesError(
            before.hoursOnly === true
              ? "Hours-only time can only move to another project that records hours only."
              : "That project records hours only, so timed work can't move there.",
            409,
          );
        }
        patch.agencyId = moveTo.agencyId;
        patch.territoryId = moveTo.territoryId;
        patch.jobId = moveTo.jobId;
        patch.visitId = moveTo.visitId;
        patch.internalJobId = moveTo.internalJobId;
        patch.kind = moveTo.kind;
        patch.billable = moveTo.billable;
      }
    }
    if (Object.keys(patch).length === 0) throw new FieldServicesError("Nothing to change.");

    const prior: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) prior[k] = (before as unknown as Record<string, unknown>)[k] ?? null;
    // Fixing the times answers the office's "please check this"; a note alone does not.
    tx.update(ref, {
      ...patch,
      ...(timesChanged ? { correctionRequest: null } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(ref.collection("revisions").doc(), {
      byUid: actor.uid,
      at: FieldValue.serverTimestamp(),
      reason: input.body.void === true ? "Removed by the worker" : "Edited by the worker",
      before: prior,
      after: patch,
    });
  });
}

/** The worker's other time (not the background day timer) that overlaps this range. */
async function overlappingEntries(
  subAccountId: string,
  workerId: string,
  start: Date,
  end: Date,
  exceptId?: string,
): Promise<number> {
  const db = getAdminDb();
  const from = Timestamp.fromMillis(start.getTime() - MAX_ENTRY_HOURS * 3_600_000);
  let docs;
  try {
    docs = (
      await db
        .collection("timeEntries")
        .where("subAccountId", "==", subAccountId)
        .where("workerId", "==", workerId)
        .where("startAt", ">", from)
        .where("startAt", "<", Timestamp.fromDate(end))
        .get()
    ).docs;
  } catch {
    // The (subAccountId, workerId, startAt) index is not built yet; read the worker's entries and filter here.
    docs = (await db.collection("timeEntries").where("workerId", "==", workerId).get()).docs.filter((d) => {
      const s = toDate(d.data().startAt)?.getTime() ?? 0;
      return d.data().subAccountId === subAccountId && s > from.toMillis() && s < end.getTime();
    });
  }
  return docs.filter((d) => {
    const e = d.data();
    if (d.id === exceptId || e.voided === true || e.hoursOnly === true || isDayTimer(e)) return false;
    const eEnd = toDate(e.endAt);
    return e.running === true || (eEnd !== null && eEnd.getTime() > start.getTime());
  }).length;
}

/** Adds finished time on a visit, a job, an internal job or no job. Workers add their own; the office adds for anyone. */
export async function addTimeOnTarget(input: {
  subAccountId: string;
  actor: FieldActor;
  workerId?: string;
  target: TimeTarget;
  startAt: unknown;
  endAt: unknown;
  note?: string;
  /** Required from the office. A worker's own entries get a default. */
  reason?: string;
  /** Chosen by the phone so a repeated request cannot add the same time twice. */
  clientId?: string;
}): Promise<{ id: string; warnings: string[] }> {
  const { subAccountId, actor } = input;
  const config = await requireTimesheets(subAccountId);
  const reason = (input.reason ?? "").trim().slice(0, 300);
  if (actor.isOffice && !reason) throw new FieldServicesError("Say why you are adding this time entry.");
  const workerId = pickWorkerId(actor, input.workerId);

  const { s, e } = checkRange(input.startAt, input.endAt, actor.isOffice, (config.minEntryMinutes ?? 10) * 60_000);

  const db = getAdminDb();
  // A retry of the same phone request (for example after a dropped signal) returns the entry it already made.
  const clientId = typeof input.clientId === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(input.clientId) ? input.clientId : null;
  const ref = clientId
    ? db.doc(`timeEntries/ci_${workerId}_${clientId}`)
    : db.collection("timeEntries").doc();
  if (clientId) await loadActiveWorker(subAccountId, workerId);
  if (clientId && (await ref.get()).exists) return { id: ref.id, warnings: [] };
  await assertWeekEditable(subAccountId, workerId, s);
  if (!actor.isOffice) await assertUnderDayLimit({ subAccountId, workerId, config, start: s, end: e });

  const resolved = await resolveTarget({ subAccountId, actor, workerId, target: input.target, forTimer: false });
  if (resolved.hoursOnly) {
    throw new FieldServicesError("This project records hours only. Enter the date and the hours instead.", 409);
  }
  const clashes = await overlappingEntries(subAccountId, workerId, s, e);
  const warnings: string[] = [];
  if (clashes > 0) {
    // A worker can't book the same hour twice; the office can, with a warning, to fix odd data.
    if (!actor.isOffice) {
      throw new FieldServicesError(
        "That overlaps time you already logged. Change the times or edit the other entry.",
        409,
      );
    }
    warnings.push(`This overlaps ${clashes} other time ${clashes === 1 ? "entry" : "entries"}.`);
  }

  const batch = db.batch();
  batch.set(
    ref,
    entryDoc(resolved, subAccountId, workerId, {
      startAt: Timestamp.fromDate(s),
      endAt: Timestamp.fromDate(e),
      running: false,
      source: "manual",
      note: (input.note ?? "").trim().slice(0, 500),
    }),
  );
  batch.set(ref.collection("revisions").doc(), {
    byUid: actor.uid,
    at: FieldValue.serverTimestamp(),
    reason: reason || "Added by the worker",
    before: null,
    after: { startAt: s.toISOString(), endAt: e.toISOString(), source: "manual" },
  });
  await batch.commit();
  await markWorkerActive(subAccountId, workerId, resolved.agencyId);
  return { id: ref.id, warnings };
}

/** Adds time to a project that records hours only: a day and a length, with no start or end. */
export async function addHoursOnTarget(input: {
  subAccountId: string;
  actor: FieldActor;
  workerId?: string;
  target: TimeTarget;
  date: unknown;
  minutes: unknown;
  note?: string;
  reason?: string;
  clientId?: string;
}): Promise<{ id: string; warnings: string[] }> {
  const { subAccountId, actor } = input;
  if (input.target.type === "visit") throw new FieldServicesError("Add hours to the project, not to a visit.");
  const config = await requireTimesheets(subAccountId);
  const reason = (input.reason ?? "").trim().slice(0, 300);
  if (actor.isOffice && !reason) throw new FieldServicesError("Say why you are adding this time entry.");
  const workerId = pickWorkerId(actor, input.workerId);
  if (typeof input.date !== "string" || !isDayKey(input.date)) throw new FieldServicesError("Pick a day.");
  const date = input.date;
  const minutes = cleanMinutes(input.minutes);
  const tz = await workspaceTimezone(subAccountId);
  const today = zonedDateKey(new Date(), tz);
  if (date > today) throw new FieldServicesError("That day hasn't happened yet.");
  if (!actor.isOffice) {
    if (date < addDaysToKey(today, -WORKER_BACKDATE_DAYS)) {
      throw new FieldServicesError("That is too far back. Ask the office to add it.");
    }
    const minMin = config.minEntryMinutes ?? 10;
    if (minutes < minMin) throw new FieldServicesError(`An entry has to be at least ${minMin} minutes.`);
  }
  const s = zonedTimeToUtc(`${date}T00:00`, tz);
  const e = new Date(s.getTime() + minutes * 60_000);

  const db = getAdminDb();
  const clientId = typeof input.clientId === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(input.clientId) ? input.clientId : null;
  const ref = clientId ? db.doc(`timeEntries/ci_${workerId}_${clientId}`) : db.collection("timeEntries").doc();
  if (clientId) await loadActiveWorker(subAccountId, workerId);
  if (clientId && (await ref.get()).exists) return { id: ref.id, warnings: [] };
  await assertWeekEditable(subAccountId, workerId, s);
  if (!actor.isOffice) await assertUnderDayLimit({ subAccountId, workerId, config, start: s, end: e, fixed: true });

  const resolved = await resolveTarget({ subAccountId, actor, workerId, target: input.target, forTimer: false });
  if (!resolved.hoursOnly) {
    throw new FieldServicesError("This project records start and end times, so enter those.", 409);
  }

  const batch = db.batch();
  batch.set(
    ref,
    entryDoc(resolved, subAccountId, workerId, {
      startAt: Timestamp.fromDate(s),
      endAt: Timestamp.fromDate(e),
      running: false,
      source: "manual",
      note: (input.note ?? "").trim().slice(0, 500),
      hours: { minutes, date },
    }),
  );
  batch.set(ref.collection("revisions").doc(), {
    byUid: actor.uid,
    at: FieldValue.serverTimestamp(),
    reason: reason || "Added by the worker",
    before: null,
    after: { date, durationMinutes: minutes, source: "manual" },
  });
  await batch.commit();
  await markWorkerActive(subAccountId, workerId, resolved.agencyId);
  return { id: ref.id, warnings: [] };
}

export async function requestTimeCorrection(input: {
  subAccountId: string;
  entryId: string;
  actor: FieldActor;
  note: string;
}): Promise<void> {
  const note = input.note.trim().slice(0, 500);
  if (!note) throw new FieldServicesError("Say what is wrong with the time.");
  const { ref, data } = await loadEntry(input.subAccountId, input.entryId);
  if (!input.actor.isOffice && data.workerId !== input.actor.workerId) {
    throw new FieldServicesError("That isn't your time entry.", 403);
  }
  await ref.update({
    correctionRequest: { note, at: Date.now() },
    updatedAt: FieldValue.serverTimestamp(),
  });

  let label = "general time";
  let contactId: string | null = null;
  if (data.visitId) {
    const visit = await loadVisit(input.subAccountId, data.visitId);
    label = `${visit.jobNumber} ${visit.jobTitle}`.trim();
    contactId = visit.contactId;
  } else if (data.jobId) {
    const job = await loadJob(input.subAccountId, data.jobId).catch(() => null);
    if (job) {
      label = `${job.number} ${job.title}`.trim();
      contactId = job.contactId;
    }
  } else if (data.internalJobId) {
    const internal = await loadInternalJob(input.subAccountId, data.internalJobId).catch(() => null);
    if (internal) label = internal.name;
  }
  await createTaskServerSide({
    subAccountId: data.subAccountId,
    agencyId: data.agencyId,
    createdByUid: input.actor.uid,
    mode: "live",
    title: `Time correction asked: ${label}`,
    notes: note,
    dueAt: null,
    contactId,
    dealId: null,
    eventId: null,
  }).catch((err) => console.warn("[field-time] correction task failed", err));
}

/** maxHoursFor returns null for a workspace whose timers must be left alone. */
export async function closeStaleTimers(maxHoursFor: (subAccountId: string) => Promise<number | null>): Promise<number> {
  const db = getAdminDb();
  const docs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  // Every clocked-in worker holds a running timer, so read them all in pages rather than the first few.
  for (let page = 0; page < STALE_SWEEP_PAGES; page++) {
    let q = db
      .collection("timeEntries")
      .where("running", "==", true)
      .orderBy(FieldPath.documentId())
      .limit(STALE_SWEEP_PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    docs.push(...snap.docs);
    if (snap.size < STALE_SWEEP_PAGE) break;
    last = snap.docs[snap.docs.length - 1];
  }
  let closed = 0;
  const hours = new Map<string, number | null>();
  for (const d of docs) {
    const e = d.data() as TimeEntry;
    const start = toDate(e.startAt);
    if (!start) continue;
    if (!hours.has(e.subAccountId)) hours.set(e.subAccountId, await maxHoursFor(e.subAccountId));
    const limitHours = hours.get(e.subAccountId);
    if (limitHours === null) continue;
    const limitMs = (limitHours ?? 12) * 3_600_000;
    if (Date.now() - start.getTime() < limitMs) continue;
    // Re-check inside the transaction so a timer just stopped is not overwritten.
    const didClose = await db.runTransaction(async (tx) => {
      const fresh = (await tx.get(d.ref)).data() as TimeEntry | undefined;
      if (!fresh || !fresh.running) return false;
      tx.update(d.ref, {
        endAt: Timestamp.fromMillis(start.getTime() + limitMs),
        running: false,
        autoClosed: true,
        correctionRequest: { note: "Timer ran past the limit and was stopped automatically. Please check it.", at: Date.now() },
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (didClose) {
      closed++;
      // A timer left running that long means a forgotten clock out, so the day ends with it.
      await endWorkday(e.subAccountId, e.workerId).catch(() => {});
    }
  }
  return closed;
}
