import "server-only";

import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDayKey, mondayOf, unionMs, type Span } from "@/lib/field-services/intervals";
import { zonedDateKey, zonedTimeToUtc, addDaysToKey } from "@/lib/field-services/time";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { pushToWorker } from "@/lib/server/field-worker-push";

export type SheetStatus = "open" | "submitted" | "approved" | "sent_back";

export interface SheetView {
  weekStart: string;
  status: SheetStatus;
  /** Why the office sent the week back or reopened it. */
  note: string;
  submittedAt: string | null;
  approvedAt: string | null;
  /** What the worker wrote about each day, by date. */
  dayNotes: Record<string, string>;
}

interface HistoryItem {
  at: number;
  by: string;
  action: string;
  note: string;
}

const MAX_HISTORY = 50;
const ID = /^[A-Za-z0-9_-]{6,80}$/;

export async function workspaceTimezone(subAccountId: string): Promise<string> {
  const tz = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data()?.timezone;
  return typeof tz === "string" && tz ? tz : "UTC";
}

export function weekStartOf(ms: number, tz: string): string {
  return mondayOf(zonedDateKey(new Date(ms), tz));
}

export function weekBounds(weekStart: string, tz: string): { from: Date; to: Date } {
  return {
    from: zonedTimeToUtc(`${weekStart}T00:00`, tz),
    to: zonedTimeToUtc(`${addDaysToKey(weekStart, 7)}T00:00`, tz),
  };
}

/** A week can be submitted or approved on any day once it has started, so a casual who works one day can submit it. */
export function weekClosable(weekStart: string, tz: string, now: Date = new Date()): boolean {
  return weekStart <= mondayOf(zonedDateKey(now, tz));
}

function sheetRef(workerId: string, weekStart: string) {
  return getAdminDb().doc(`fieldTimesheets/${workerId}_${weekStart}`);
}

function validWeekStart(v: unknown): string {
  if (!isDayKey(v) || mondayOf(v) !== v) throw new FieldServicesError("Choose a week that starts on a Monday.");
  return v;
}

function ms(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

function iso(v: unknown): string | null {
  const m = ms(v);
  return m === null ? null : new Date(m).toISOString();
}

async function requireTimesheets(subAccountId: string): Promise<void> {
  if (!(await getFieldServicesConfig(subAccountId)).timesheetsEnabled) {
    throw new FieldServicesError("Timesheets are switched off for this workspace.", 409);
  }
}

export async function readSheet(
  subAccountId: string,
  workerId: string,
  weekStart: string,
): Promise<SheetView> {
  const empty: SheetView = { weekStart, status: "open", note: "", submittedAt: null, approvedAt: null, dayNotes: {} };
  if (!ID.test(workerId)) return empty;
  const d = (await sheetRef(workerId, weekStart).get()).data();
  if (!d || d.subAccountId !== subAccountId) return empty;
  const status = (["submitted", "approved", "sent_back", "open"] as string[]).includes(d.status)
    ? (d.status as SheetStatus)
    : "open";
  return {
    weekStart,
    status,
    note: typeof d.note === "string" ? d.note : "",
    submittedAt: iso(d.submittedAt),
    approvedAt: iso(d.approvedAt),
    dayNotes: cleanDayNotes(d.dayNotes),
  };
}

const MAX_DAY_NOTE = 500;

function cleanDayNotes(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (isDayKey(k) && typeof n === "string" && n.trim()) out[k] = n.slice(0, MAX_DAY_NOTE);
    }
  }
  return out;
}

/** Saves what a worker wants the office to know about one day. An empty note clears it. */
export async function setDayNote(input: {
  subAccountId: string;
  workerId: string | null;
  date: unknown;
  note: unknown;
}): Promise<void> {
  const { subAccountId } = input;
  await requireTimesheets(subAccountId);
  const workerId = assertWorkerOwn(input.workerId);
  if (!isDayKey(input.date)) throw new FieldServicesError("Choose a day.");
  const tz = await workspaceTimezone(subAccountId);
  const today = zonedDateKey(new Date(), tz);
  if (input.date > addDaysToKey(today, 1) || input.date < addDaysToKey(today, -120)) {
    throw new FieldServicesError("That day is too far from today for a note.", 409);
  }
  const weekStart = mondayOf(input.date);
  const worker = await requireWorkerInWorkspace(subAccountId, workerId);
  const sheet = await readSheet(subAccountId, workerId, weekStart);
  if (isLocked(sheet.status)) {
    throw new FieldServicesError(
      sheet.status === "approved"
        ? "That week is approved and locked. Ask the office to unlock it."
        : "That week is submitted and locked. Withdraw it first, or ask the office.",
      409,
    );
  }
  const text = typeof input.note === "string" ? input.note.trim().slice(0, MAX_DAY_NOTE) : "";
  const ref = sheetRef(workerId, weekStart);
  const existing = (await ref.get()).exists;
  await ref.set(
    {
      agencyId: worker.agencyId,
      subAccountId,
      workerId,
      weekStart,
      ...(existing ? {} : { status: "open" }),
      dayNotes: { [input.date]: text ? text : FieldValue.delete() },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export const isLocked = (status: SheetStatus) => status === "submitted" || status === "approved";

/** Refuses a change to time in a week that is submitted or approved. Does nothing while timesheets are off. */
export async function assertWeekEditable(
  subAccountId: string,
  workerId: string,
  at: Date | number,
  opts: { reopenSubmitted?: boolean } = {},
): Promise<void> {
  if (!(await getFieldServicesConfig(subAccountId)).timesheetsEnabled) return;
  const tz = await workspaceTimezone(subAccountId);
  const weekStart = weekStartOf(typeof at === "number" ? at : at.getTime(), tz);
  const sheet = await readSheet(subAccountId, workerId, weekStart);
  if (isLocked(sheet.status)) {
    // Starting new work after submitting reopens the week, so the worker submits it again.
    if (opts.reopenSubmitted && sheet.status === "submitted") {
      const worker = await requireWorkerInWorkspace(subAccountId, workerId);
      await writeSheet({
        subAccountId,
        agencyId: worker.agencyId,
        workerId,
        weekStart,
        status: "open",
        by: "system",
        action: "reopened",
        note: "New time was started after this week was submitted.",
        allowFrom: ["submitted", "open"],
      });
      return;
    }
    throw new FieldServicesError(
      sheet.status === "approved"
        ? "That week is approved and locked. Ask the office to unlock it."
        : "That week is submitted and locked. Withdraw it first, or ask the office.",
      409,
    );
  }
}

/** A worker's entries that start inside [from, to). Falls back to a slower read until the index is built. */
export async function entriesInRange(
  subAccountId: string,
  workerId: string,
  from: Date,
  to: Date,
): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const db = getAdminDb();
  let docs;
  try {
    docs = (
      await db
        .collection("timeEntries")
        .where("subAccountId", "==", subAccountId)
        .where("workerId", "==", workerId)
        .where("startAt", ">=", Timestamp.fromDate(from))
        .where("startAt", "<", Timestamp.fromDate(to))
        .get()
    ).docs;
  } catch (err) {
    console.warn("[field-timesheet] using the slow path; deploy firestore indexes", err);
    docs = (await db.collection("timeEntries").where("workerId", "==", workerId).get()).docs.filter((d) => {
      const s = ms(d.data().startAt);
      return d.data().subAccountId === subAccountId && s !== null && s >= from.getTime() && s < to.getTime();
    });
  }
  return docs.map((d) => ({ id: d.id, data: d.data() }));
}

export async function weekTotals(
  subAccountId: string,
  workerId: string,
  weekStart: string,
  tz: string,
): Promise<{ totalMs: number; count: number; running: boolean }> {
  const { from, to } = weekBounds(weekStart, tz);
  const rows = await entriesInRange(subAccountId, workerId, from, to);
  const now = Date.now();
  const intervals: Span[] = [];
  let count = 0;
  let running = false;
  for (const r of rows) {
    if (r.data.voided === true) continue;
    count++;
    const s = ms(r.data.startAt);
    if (s === null) continue;
    if (r.data.running === true) {
      running = true;
      intervals.push([s, now]);
    } else {
      const e = ms(r.data.endAt);
      if (e !== null) intervals.push([s, e, r.data.hoursOnly === true]);
    }
  }
  return { totalMs: unionMs(intervals), count, running };
}

export async function requireWorkerInWorkspace(subAccountId: string, workerId: string) {
  if (!ID.test(workerId)) throw new FieldServicesError("Worker not found.", 404);
  const snap = await getAdminDb().doc(`fieldWorkers/${workerId}`).get();
  const w = snap.data();
  if (!snap.exists || !w || w.subAccountId !== subAccountId) {
    throw new FieldServicesError("Worker not found.", 404);
  }
  return { agencyId: w.agencyId as string, name: String(w.name ?? "") };
}

async function writeSheet(input: {
  subAccountId: string;
  agencyId: string;
  workerId: string;
  weekStart: string;
  status: SheetStatus;
  by: string;
  action: string;
  note: string;
  allowFrom: SheetStatus[];
  extra?: Record<string, unknown>;
}): Promise<boolean> {
  const db = getAdminDb();
  const ref = sheetRef(input.workerId, input.weekStart);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists && snap.data()?.subAccountId === input.subAccountId
      ? ((snap.data()?.status as SheetStatus) ?? "open")
      : "open";
    if (cur === input.status) return false;
    if (!input.allowFrom.includes(cur)) {
      throw new FieldServicesError(
        cur === "approved"
          ? "That week is already approved."
          : cur === "submitted"
            ? "That week is already submitted."
            : "That can't be done to this week right now.",
        409,
      );
    }
    const history = ((snap.data()?.history as HistoryItem[] | undefined) ?? []).slice(-(MAX_HISTORY - 1));
    history.push({ at: Date.now(), by: input.by, action: input.action, note: input.note.slice(0, 300) });
    tx.set(
      ref,
      {
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        workerId: input.workerId,
        weekStart: input.weekStart,
        status: input.status,
        note: input.note.slice(0, 300),
        history,
        updatedAt: FieldValue.serverTimestamp(),
        ...(input.extra ?? {}),
      },
      { merge: true },
    );
    return true;
  });
}

function assertWorkerOwn(workerId: string | null): string {
  if (!workerId) throw new FieldServicesError("Only a worker with a profile can submit a week.", 403);
  return workerId;
}

export async function submitWeek(input: {
  subAccountId: string;
  workerId: string | null;
  uid: string;
  weekStart: unknown;
}): Promise<void> {
  const { subAccountId } = input;
  await requireTimesheets(subAccountId);
  const workerId = assertWorkerOwn(input.workerId);
  const weekStart = validWeekStart(input.weekStart);
  const tz = await workspaceTimezone(subAccountId);
  if (!weekClosable(weekStart, tz)) {
    throw new FieldServicesError("That week hasn't started yet.", 409);
  }
  const worker = await requireWorkerInWorkspace(subAccountId, workerId);
  const totals = await weekTotals(subAccountId, workerId, weekStart, tz);
  if (totals.running) throw new FieldServicesError("Stop your timer first.", 409);
  if (totals.count === 0) throw new FieldServicesError("There is no time logged this week.", 409);
  await writeSheet({
    subAccountId,
    agencyId: worker.agencyId,
    workerId,
    weekStart,
    status: "submitted",
    by: input.uid,
    action: "submitted",
    note: "",
    allowFrom: ["open", "sent_back", "submitted"],
    extra: { submittedAt: FieldValue.serverTimestamp(), submittedMs: totals.totalMs, entryCount: totals.count },
  });
}

export async function withdrawWeek(input: {
  subAccountId: string;
  workerId: string | null;
  uid: string;
  weekStart: unknown;
}): Promise<void> {
  const { subAccountId } = input;
  await requireTimesheets(subAccountId);
  const workerId = assertWorkerOwn(input.workerId);
  const weekStart = validWeekStart(input.weekStart);
  const worker = await requireWorkerInWorkspace(subAccountId, workerId);
  await writeSheet({
    subAccountId,
    agencyId: worker.agencyId,
    workerId,
    weekStart,
    status: "open",
    by: input.uid,
    action: "withdrawn",
    note: "",
    allowFrom: ["submitted", "open", "sent_back"],
  });
}

export async function approveWeek(input: {
  subAccountId: string;
  workerId: string;
  weekStart: unknown;
  byUid: string;
}): Promise<void> {
  const { subAccountId } = input;
  await requireTimesheets(subAccountId);
  const weekStart = validWeekStart(input.weekStart);
  const worker = await requireWorkerInWorkspace(subAccountId, input.workerId);
  const tz = await workspaceTimezone(subAccountId);
  if (!weekClosable(weekStart, tz)) {
    throw new FieldServicesError("That week hasn't started yet.", 409);
  }
  const totals = await weekTotals(subAccountId, input.workerId, weekStart, tz);
  if (totals.running) throw new FieldServicesError("A timer is still running in that week.", 409);
  await writeSheet({
    subAccountId,
    agencyId: worker.agencyId,
    workerId: input.workerId,
    weekStart,
    status: "approved",
    by: input.byUid,
    action: "approved",
    note: "",
    allowFrom: ["open", "submitted", "sent_back", "approved"],
    extra: {
      approvedAt: FieldValue.serverTimestamp(),
      approvedByUid: input.byUid,
      approvedMs: totals.totalMs,
      entryCount: totals.count,
    },
  });
}

export async function sendBackWeek(input: {
  subAccountId: string;
  workerId: string;
  weekStart: unknown;
  byUid: string;
  note: unknown;
}): Promise<void> {
  const { subAccountId } = input;
  await requireTimesheets(subAccountId);
  const weekStart = validWeekStart(input.weekStart);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : "";
  if (!note) throw new FieldServicesError("Say what needs fixing.");
  const worker = await requireWorkerInWorkspace(subAccountId, input.workerId);
  const changed = await writeSheet({
    subAccountId,
    agencyId: worker.agencyId,
    workerId: input.workerId,
    weekStart,
    status: "sent_back",
    by: input.byUid,
    action: "sent back",
    note,
    allowFrom: ["submitted"],
  });
  if (changed) {
    await pushToWorker(input.workerId, {
      title: "Timesheet sent back",
      body: note,
      tag: `timesheet-${weekStart}`,
    });
  }
}

export async function unlockWeek(input: {
  subAccountId: string;
  workerId: string;
  weekStart: unknown;
  byUid: string;
  note: unknown;
}): Promise<void> {
  const { subAccountId } = input;
  await requireTimesheets(subAccountId);
  const weekStart = validWeekStart(input.weekStart);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : "";
  if (!note) throw new FieldServicesError("Say why you are unlocking this week.");
  const worker = await requireWorkerInWorkspace(subAccountId, input.workerId);
  const changed = await writeSheet({
    subAccountId,
    agencyId: worker.agencyId,
    workerId: input.workerId,
    weekStart,
    status: "open",
    by: input.byUid,
    action: "unlocked",
    note,
    allowFrom: ["approved", "submitted", "sent_back"],
  });
  if (changed) {
    await pushToWorker(input.workerId, {
      title: "Timesheet reopened",
      body: note,
      tag: `timesheet-${weekStart}`,
    });
  }
}

/** Which of these worker-weeks are approved. Used when drafting an invoice. */
export async function approvedWeeks(
  subAccountId: string,
  pairs: { workerId: string; weekStart: string }[],
  tx?: Transaction,
): Promise<Set<string>> {
  const unique = new Map<string, { workerId: string; weekStart: string }>();
  for (const p of pairs) unique.set(`${p.workerId}|${p.weekStart}`, p);
  const out = new Set<string>();
  await Promise.all(
    [...unique.entries()].map(async ([key, p]) => {
      if (!ID.test(p.workerId)) return;
      const ref = sheetRef(p.workerId, p.weekStart);
      const d = (tx ? await tx.get(ref) : await ref.get()).data();
      if (d && d.subAccountId === subAccountId && d.status === "approved") out.add(key);
    }),
  );
  return out;
}

/** True when any of these entries sits in a submitted or approved week. */
export async function anyInLockedWeek(
  subAccountId: string,
  entries: { workerId: string; startMs: number }[],
): Promise<boolean> {
  if (entries.length === 0) return false;
  if (!(await getFieldServicesConfig(subAccountId)).timesheetsEnabled) return false;
  const tz = await workspaceTimezone(subAccountId);
  const pairs = new Map<string, { workerId: string; weekStart: string }>();
  for (const e of entries) {
    const weekStart = weekStartOf(e.startMs, tz);
    pairs.set(`${e.workerId}|${weekStart}`, { workerId: e.workerId, weekStart });
  }
  const sheets = await Promise.all(
    [...pairs.values()].map((p) => readSheet(subAccountId, p.workerId, p.weekStart)),
  );
  return sheets.some((sheet) => isLocked(sheet.status));
}

export interface OfficeRow {
  removed: boolean;
  workerId: string;
  name: string;
  status: SheetStatus;
  note: string;
  totalMs: number;
  count: number;
  running: boolean;
  submittedAt: string | null;
}

export async function listWeekForOffice(subAccountId: string, weekStartRaw: unknown): Promise<{
  weekStart: string;
  timezone: string;
  rows: OfficeRow[];
}> {
  await requireTimesheets(subAccountId);
  const tz = await workspaceTimezone(subAccountId);
  const weekStart = isDayKey(weekStartRaw) ? mondayOf(weekStartRaw) : mondayOf(zonedDateKey(new Date(), tz));
  const workers = await getAdminDb()
    .collection("fieldWorkers")
    .where("subAccountId", "==", subAccountId)
    .get();
  const all = workers.docs;
  const rows: OfficeRow[] = [];
  for (let i = 0; i < all.length; i += 10) {
    const chunk = all.slice(i, i + 10);
    rows.push(
      ...(await Promise.all(
        chunk.map(async (d) => {
          const [sheet, totals] = await Promise.all([
            readSheet(subAccountId, d.id, weekStart),
            weekTotals(subAccountId, d.id, weekStart, tz),
          ]);
          return {
            removed: d.data().status !== "active",
            workerId: d.id,
            name: String(d.data().name ?? ""),
            status: sheet.status,
            note: sheet.note,
            totalMs: totals.totalMs,
            count: totals.count,
            running: totals.running,
            submittedAt: sheet.submittedAt,
          };
        }),
      )),
    );
  }
  // A removed worker only appears while they still have time that needs a decision.
  const shown = rows.filter((r) => !r.removed || r.count > 0 || r.status !== "open");
  const order: Record<SheetStatus, number> = { submitted: 0, sent_back: 1, open: 2, approved: 3 };
  shown.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  return { weekStart, timezone: tz, rows: shown };
}
