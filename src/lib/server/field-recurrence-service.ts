import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  LOOKAHEAD_DAYS,
  addDays,
  occurrenceDates,
  occurrenceStart,
  recurrenceSignature,
  validateRecurrence,
  type RecurrenceConfig,
} from "@/lib/field-services/recurrence";
import { zonedDateKey } from "@/lib/field-services/time";
import { emitFieldWebhook, serializeVisit } from "@/lib/server/field-events";
import { notifyCrew } from "@/lib/server/field-crew-notify-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getJobTerms } from "@/lib/server/field-services-config-service";
import { createGeneratedVisit, recomputeJobStatus } from "@/lib/server/field-visits-service";
import { scheduleVisitReminder } from "@/lib/server/field-messages-service";
import type { Job, Visit } from "@/types/field-services";

const REMINDER_HORIZON_MS = 72 * 3_600_000;
const PAGE = 100;
const GENERATE_BUDGET_MS = 200_000;
const TOTAL_BUDGET_MS = 270_000;

async function loadJob(subAccountId: string, jobId: string): Promise<{ ref: FirebaseFirestore.DocumentReference; job: Job }> {
  const ref = getAdminDb().doc(`jobs/${jobId}`);
  const snap = await ref.get();
  const data = snap.data() as Job | undefined;
  if (!data || data.subAccountId !== subAccountId) {
    throw new FieldServicesError(`${(await getJobTerms(subAccountId)).Job} not found.`, 404);
  }
  return { ref, job: { ...data, id: snap.id } };
}

async function activeWorkerIds(subAccountId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const db = getAdminDb();
  const snaps = await Promise.all(ids.map((id) => db.doc(`fieldWorkers/${id}`).get()));
  return snaps
    .filter((s) => s.data()?.subAccountId === subAccountId && s.data()?.status === "active")
    .map((s) => s.id);
}

interface Wanted {
  date: string;
  start: Date;
  end: Date;
}

/** The repeats that should exist in the next 12 months, not counting ones already in the past. */
function wantedOccurrences(job: Job, cfg: RecurrenceConfig, now: Date): Wanted[] {
  const today = zonedDateKey(now, job.timezone);
  return occurrenceDates(cfg, today, addDays(today, LOOKAHEAD_DAYS))
    .map((date) => {
      const start = occurrenceStart(date, cfg.time, job.timezone);
      return { date, start, end: new Date(start.getTime() + cfg.durationMinutes * 60_000) };
    })
    .filter((w) => !Number.isNaN(w.start.getTime()) && w.start.getTime() >= now.getTime());
}

/** Makes sure every repeat in the next 12 months has a visit. Returns how many were created. */
export async function generateRecurringVisits(
  jobId: string,
  now: Date = new Date(),
  preloaded?: FirebaseFirestore.DocumentSnapshot,
  opts?: { avoidStarts?: Set<number>; notesByDate?: Map<string, string> },
): Promise<number> {
  const db = getAdminDb();
  const snap = preloaded ?? (await db.doc(`jobs/${jobId}`).get());
  const data = snap.data() as Job | undefined;
  if (!data || data.jobType !== "recurring" || data.recurrence?.active !== true) return 0;
  if (data.status === "closed" || data.status === "cancelled") return 0;
  const job: Job = { ...data, id: snap.id };
  const cfg = job.recurrence as RecurrenceConfig;

  if (cfg.endsOn && zonedDateKey(now, job.timezone) > cfg.endsOn) {
    await snap.ref.update({ "recurrence.active": false, updatedAt: FieldValue.serverTimestamp() });
    await recomputeJobStatus(job.id);
    return 0;
  }

  const wanted = wantedOccurrences(job, cfg, now);
  if (wanted.length === 0) return 0;
  const existing = await db.getAll(
    ...wanted.map((w) => db.doc(`visits/rec_${job.id}_${w.date.replace(/-/g, "")}`)),
  );
  const missing = wanted.filter((_, i) => !existing[i].exists);
  if (missing.length === 0) return 0;
  const workerIds = await activeWorkerIds(job.subAccountId, cfg.workerIds);

  let created = 0;
  const todo = missing.filter((w) => !opts?.avoidStarts?.has(w.start.getTime()));
  // A year of weekly visits is a lot of writes for one request, so make them a few at a time.
  for (let i = 0; i < todo.length; i += 8) {
    const made = await Promise.all(
      todo.slice(i, i + 8).map((w) =>
        createGeneratedVisit({
          job,
          date: w.date,
          start: w.start,
          end: w.end,
          workerIds,
          sig: cfg.sig,
          notes: opts?.notesByDate?.get(w.date),
        }),
      ),
    );
    created += made.filter(Boolean).length;
  }
  return created;
}

/**
 * Removes future generated visits nobody has touched. Visits matching `keep` stay, so a small change does not recreate everything.
 */
async function removeFutureGenerated(
  job: Job,
  now: Date,
  keep?: Map<string, { start: number; end: number; workers: string }>,
): Promise<{ removed: number; notesByDate: Map<string, string> }> {
  const db = getAdminDb();
  const snap = await db.collection("visits").where("recurringOf", "==", job.id).where("status", "==", "pending").get();
  const doomed = snap.docs.filter((d) => {
    const v = d.data();
    const start = (v.scheduledStart as Timestamp | null)?.toMillis?.() ?? 0;
    if (v.subAccountId !== job.subAccountId || v.manual === true || start <= now.getTime()) return false;
    if (((v.photos as unknown[] | undefined)?.length ?? 0) > 0) return false;
    const want = keep?.get(v.occurrenceDate as string);
    if (
      want &&
      want.start === start &&
      want.end === ((v.scheduledEnd as Timestamp | null)?.toMillis?.() ?? 0) &&
      want.workers === [...((v.workerIds as string[]) ?? [])].sort().join(",")
    ) {
      return false;
    }
    return true;
  });

  const notesByDate = new Map<string, string>();
  for (const d of doomed) {
    const v = { id: d.id, ...d.data() } as Visit;
    if (v.notes && v.occurrenceDate) notesByDate.set(v.occurrenceDate, v.notes);
    const startMs = (v.scheduledStart as Timestamp | null)?.toMillis?.() ?? 0;
    emitFieldWebhook({
      subAccountId: job.subAccountId,
      agencyId: job.agencyId,
      type: "visit.cancelled",
      payload: { visit: serializeVisit({ ...v, status: "cancelled" }), generated: true },
    });
    if (startMs - now.getTime() < 48 * 3_600_000 && v.workerIds.length > 0) {
      await notifyCrew({ visitId: d.id, workerIds: v.workerIds, kind: "cancelled" });
    }
  }
  for (let i = 0; i < doomed.length; i += 400) {
    const batch = db.batch();
    for (const d of doomed.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
  return { removed: doomed.length, notesByDate };
}

export async function startRecurrence(input: {
  subAccountId: string;
  jobId: string;
  body: unknown;
}): Promise<{ created: number }> {
  const db = getAdminDb();
  const ref = db.doc(`jobs/${input.jobId}`);
  const parsed = validateRecurrence(input.body);
  if (!parsed.ok) throw new FieldServicesError(parsed.error);
  const workerIds = await activeWorkerIds(input.subAccountId, parsed.value.workerIds);
  const value = { ...parsed.value, workerIds };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const job = snap.data() as Job | undefined;
    if (!job || job.subAccountId !== input.subAccountId) {
      throw new FieldServicesError(`${(await getJobTerms(input.subAccountId)).Job} not found.`, 404);
    }
    if (job.status === "closed" || job.status === "cancelled") {
      throw new FieldServicesError(`A closed or cancelled ${(await getJobTerms(input.subAccountId)).job} can't repeat.`, 409);
    }
    if (job.jobType === "recurring" && job.recurrence?.active) {
      throw new FieldServicesError(`This ${(await getJobTerms(input.subAccountId)).job} already repeats. Change its schedule instead.`, 409);
    }
    tx.update(ref, {
      jobType: "recurring",
      recurrence: {
        ...value,
        active: true,
        skipped: job.recurrence?.skipped ?? [],
        sig: recurrenceSignature(value),
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  // Visits the office already booked on this job are not duplicated.
  const booked = await db.collection("visits").where("jobId", "==", input.jobId).get();
  const avoidStarts = new Set<number>();
  for (const d of booked.docs) {
    const v = d.data();
    if (v.subAccountId === input.subAccountId && v.status !== "cancelled") {
      const ms = (v.scheduledStart as Timestamp | null)?.toMillis?.();
      if (ms) avoidStarts.add(ms);
    }
  }
  const created = await generateRecurringVisits(input.jobId, new Date(), undefined, { avoidStarts });
  await recomputeJobStatus(input.jobId);
  return { created };
}

export async function updateRecurrence(input: {
  subAccountId: string;
  jobId: string;
  body: unknown;
}): Promise<{ created: number; removed: number }> {
  const { ref, job } = await loadJob(input.subAccountId, input.jobId);
  if (job.jobType !== "recurring" || !job.recurrence?.active) {
    throw new FieldServicesError(`This ${(await getJobTerms(input.subAccountId)).job} doesn't repeat yet.`, 409);
  }
  const parsed = validateRecurrence(input.body);
  if (!parsed.ok) throw new FieldServicesError(parsed.error);
  const workerIds = await activeWorkerIds(input.subAccountId, parsed.value.workerIds);
  const value = { ...parsed.value, workerIds };
  const next: RecurrenceConfig = {
    ...value,
    active: true,
    skipped: job.recurrence.skipped ?? [],
    sig: recurrenceSignature(value),
  };
  // Save the new schedule first so a run already in flight on the old one cannot add visits afterwards.
  await ref.update({ recurrence: next, updatedAt: FieldValue.serverTimestamp() });

  const now = new Date();
  const keep = new Map(
    wantedOccurrences(job, next, now).map((w) => [
      w.date,
      { start: w.start.getTime(), end: w.end.getTime(), workers: [...workerIds].sort().join(",") },
    ]),
  );
  const { removed, notesByDate } = await removeFutureGenerated(job, now, keep);
  const created = await generateRecurringVisits(input.jobId, now, undefined, { notesByDate });
  await recomputeJobStatus(input.jobId);
  return { created, removed };
}

export async function stopRecurrence(input: { subAccountId: string; jobId: string }): Promise<{ removed: number }> {
  const { ref, job } = await loadJob(input.subAccountId, input.jobId);
  if (job.jobType !== "recurring" || !job.recurrence?.active) {
    throw new FieldServicesError(`This ${(await getJobTerms(input.subAccountId)).job} doesn't repeat.`, 409);
  }
  await ref.update({ "recurrence.active": false, updatedAt: FieldValue.serverTimestamp() });
  const { removed } = await removeFutureGenerated(job, new Date());
  await recomputeJobStatus(input.jobId);
  return { removed };
}

/** Top-up plus queuing reminders for visits that are now close. Pages through every repeating job. */
export async function runRecurringSweep(now: Date = new Date()): Promise<{ jobs: number; created: number; reminders: number; complete: boolean }> {
  const db = getAdminDb();
  const started = Date.now();
  const gate = new Map<string, boolean>();
  const gateOn = async (subAccountId: string) => {
    if (!gate.has(subAccountId)) {
      gate.set(subAccountId, fieldServicesAvailable((await db.doc(`subAccounts/${subAccountId}`).get()).data()));
    }
    return gate.get(subAccountId)!;
  };

  let created = 0;
  let count = 0;
  let complete = true;
  const subAccounts = new Set<string>();
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db
      .collection("jobs")
      .where("recurrence.active", "==", true)
      .orderBy(FieldPath.documentId())
      .limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;
    for (const d of page.docs) {
      if (Date.now() - started > GENERATE_BUDGET_MS) {
        complete = false;
        break;
      }
      const job = d.data() as Job;
      if (!(await gateOn(job.subAccountId))) continue;
      count++;
      subAccounts.add(job.subAccountId);
      try {
        created += await generateRecurringVisits(d.id, now, d);
      } catch (err) {
        console.warn("[field-recurrence] generation failed", d.id, err);
      }
    }
    if (!complete || page.size < PAGE) break;
    last = page.docs[page.docs.length - 1];
  }

  let reminders = 0;
  for (const subAccountId of subAccounts) {
    if (Date.now() - started > TOTAL_BUDGET_MS) {
      complete = false;
      break;
    }
    const soon = await db
      .collection("visits")
      .where("subAccountId", "==", subAccountId)
      .where("scheduledStart", ">=", Timestamp.fromMillis(now.getTime()))
      .where("scheduledStart", "<=", Timestamp.fromMillis(now.getTime() + REMINDER_HORIZON_MS))
      .get();
    const due = soon.docs.filter((v) => {
      const data = v.data();
      const version = (data.reminderVersion as number | undefined) ?? 1;
      return !!data.recurringOf && data.status === "pending" && data.reminderQueuedVersion !== version;
    });
    if (due.length === 0) continue;

    const jobIds = [...new Set(due.map((v) => v.data().jobId as string))];
    const jobSnaps = await db.getAll(...jobIds.map((id) => db.doc(`jobs/${id}`)));
    const zones = new Map(jobSnaps.map((j) => [j.id, (j.data()?.timezone as string | undefined) ?? "UTC"]));

    for (let i = 0; i < due.length; i += 10) {
      if (Date.now() - started > TOTAL_BUDGET_MS) {
        complete = false;
        break;
      }
      await Promise.all(
        due.slice(i, i + 10).map(async (v) => {
          const data = v.data();
          const version = (data.reminderVersion as number | undefined) ?? 1;
          await scheduleVisitReminder({
            id: v.id,
            scheduledStart: (data.scheduledStart as Timestamp).toDate(),
            reminderVersion: version,
            timezone: zones.get(data.jobId as string) ?? "UTC",
          }).catch((err) => console.warn("[field-recurrence] reminder failed", err));
          await v.ref.update({ reminderQueuedVersion: version }).catch(() => {});
          reminders++;
        }),
      );
    }
  }
  return { jobs: count, created, reminders, complete };
}
