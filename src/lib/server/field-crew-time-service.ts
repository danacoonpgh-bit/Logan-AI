import "server-only";

import { DEFAULT_TIME_KINDS } from "@/lib/field-services/time-kinds";
import type { TimeKindDef } from "@/types/field-services";
import { jobTerms } from "@/lib/field-services/terms";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDayKey, mondayOf, unionMs, type Span } from "@/lib/field-services/intervals";
import { addDaysToKey, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import type { FieldActor } from "@/lib/server/field-access";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { existingInvoiceIds } from "@/lib/server/field-invoicing";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import {
  addHoursOnTarget,
  addTimeOnTarget,
  clockIn,
  clockOut,
  editOwnTimeEntry,
  getWorkday,
  startTimeEntry,
  stopEntry,
  type JobTimeKind,
  type TimeTarget,
} from "@/lib/server/field-time-service";
import {
  addExpense,
  defaultExpenseCurrency,
  editExpense,
  listWeekExpenses,
  voidExpense,
  type CrewExpenseView,
} from "@/lib/server/field-expenses-service";
import { listTimeTargets, type TimeTargets } from "@/lib/server/field-time-targets-service";
import {
  entriesInRange,
  isLocked,
  readSheet,
  setDayNote,
  submitWeek,
  weekClosable,
  withdrawWeek,
  type SheetView,
} from "@/lib/server/field-timesheet-service";

const ID = /^[A-Za-z0-9_-]{6,80}$/;

import { projectKindOf, type ProjectKind } from "@/lib/field-services/project-kind";

export interface CrewEntryView {
  id: string;
  startAt: string | null;
  endAt: string | null;
  running: boolean;
  kind: string;
  /** What the time is on, in words: the job, the internal job, or general time. */
  label: string;
  /** The project's own name and number, apart, and its type for colour. Null for general time and breaks. */
  title: string;
  number: string | null;
  projectKind: ProjectKind | null;
  target: { type: "visit" | "job" | "internal" | "none"; id: string | null };
  note: string;
  billable: boolean;
  flagged: boolean;
  /** Hours only: a day and a length, so no clock times are shown. */
  hoursOnly: boolean;
  /** On an invoice. */
  invoiced: boolean;
  /** The worker can't change it: it is on an invoice, or its week is submitted or approved. */
  locked: boolean;
  autoClosed: boolean;
}

export interface CrewTimeState {
  enabled: boolean;
  /** The worker's own profile id, used to keep saved entries on the phone apart per person. */
  workerId: string;
  timezone: string;
  now: string;
  workday: { active: boolean; startedAt: string | null };
  /** The day clock (clock in and out) is on for this workspace. */
  dayClock: boolean;
  clock24: boolean;
  /** The kinds of time the workspace offers, including retired ones so older entries keep their name. */
  timeKinds: TimeKindDef[];
  running: CrewEntryView | null;
  date: string;
  entries: CrewEntryView[];
  dayMs: number;
  week: { date: string; ms: number }[];
  /** The whole week with overlap counted once, which is not always the sum of the days. */
  weekMs: number;
  /** Where this week stands: open, submitted, approved or sent back. */
  sheet: SheetView & { canSubmit: boolean };
  /** Only sent when asked for, because working it out reads every job the worker may book. */
  targets: TimeTargets | null;
  /** Every entry in the week. Only the office asks for this. */
  weekEntries: CrewEntryView[] | null;
  /** The week by job: hours per day for each job, internal job or general time. No money. */
  weekRows: WeekRow[];
  /** The worker's expense claims for the week. */
  expenses: CrewExpenseView[];
  /** Currency for a claim that is not for a job. */
  expenseCurrency: string;
  /** Colour preset the office chose for the Submit week button. */
  submitButtonColor: string;
  /** The workspace's own word for a job, for the crew screens. */
  jobWord: string;
  jobWordPlural: string;
  activityWord: string;
}

export interface WeekRow {
  key: string;
  label: string;
  title?: string;
  number?: string | null;
  projectKind?: ProjectKind | null;
  type: "job" | "internal" | "none";
  /** The job or internal job id, or null for general time and breaks. */
  targetId: string | null;
  /** What the time was for (visit, travel, admin, general or break). */
  kind: string;
  /** The project records hours only. */
  hoursOnly: boolean;
  /** Monday to Sunday, in milliseconds. */
  days: number[];
  totalMs: number;
}

function ms(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

function iso(v: unknown): string | null {
  const m = ms(v);
  return m === null ? null : new Date(m).toISOString();
}

const EMPTY_STATE = (timezone: string): CrewTimeState => ({
  enabled: false,
  workerId: "",
  timezone,
  now: new Date().toISOString(),
  workday: { active: false, startedAt: null },
  dayClock: false,
  clock24: false,
  timeKinds: DEFAULT_TIME_KINDS,
  running: null,
  date: "",
  entries: [],
  dayMs: 0,
  week: [],
  weekMs: 0,
  sheet: { weekStart: "", status: "open", note: "", submittedAt: null, approvedAt: null, dayNotes: {}, canSubmit: false },
  targets: null,
  weekEntries: null,
  weekRows: [],
  expenses: [],
  expenseCurrency: "USD",
  submitButtonColor: "default",
  jobWord: "Job",
  jobWordPlural: "Jobs",
  activityWord: "Activity",
});

export async function crewTimeState(input: {
  subAccountId: string;
  workerId: string;
  date?: string | null;
  includeTargets?: boolean;
  includeWeekEntries?: boolean;
}): Promise<CrewTimeState> {
  const { subAccountId, workerId } = input;
  const db = getAdminDb();
  const [config, subSnap] = await Promise.all([
    getFieldServicesConfig(subAccountId),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  const tzRaw = subSnap.data()?.timezone;
  const timezone = typeof tzRaw === "string" && tzRaw ? tzRaw : "UTC";
  if (!config.timesheetsEnabled) return EMPTY_STATE(timezone);

  const nowDate = new Date();
  const today = zonedDateKey(nowDate, timezone);
  const date = isDayKey(input.date) ? input.date : today;
  const weekStart = mondayOf(date);
  const weekEnd = addDaysToKey(weekStart, 7);
  const from = zonedTimeToUtc(`${weekStart}T00:00`, timezone);
  const to = zonedTimeToUtc(`${weekEnd}T00:00`, timezone);

  const [weekDocs, runningSnap, workday, targets, sheet, expenseCurrency, weekExpenses] = await Promise.all([
    entriesInRange(subAccountId, workerId, from, to),
    db.collection("timeEntries").where("workerId", "==", workerId).where("running", "==", true).get(),
    getWorkday(subAccountId, workerId),
    input.includeTargets ? listTimeTargets({ subAccountId, workerId }) : Promise.resolve(null),
    readSheet(subAccountId, workerId, weekStart),
    defaultExpenseCurrency(subAccountId, workerId),
    listWeekExpenses({ subAccountId, workerId, weekStart }),
  ]);
  const weekLocked = isLocked(sheet.status);
  const expenses = weekExpenses.map((e) => ({ ...e, locked: weekLocked }));

  const rows = new Map<string, Record<string, unknown>>();
  for (const d of weekDocs) rows.set(d.id, d.data);
  for (const d of runningSnap.docs) {
    if (d.data().subAccountId === subAccountId) rows.set(d.id, d.data());
  }

  const jobIds = new Set<string>();
  const internalIds = new Set<string>();
  const invoiceIds: string[] = [];
  for (const e of rows.values()) {
    if (typeof e.jobId === "string") jobIds.add(e.jobId);
    if (typeof e.internalJobId === "string") internalIds.add(e.internalJobId);
    if (typeof e.invoiceId === "string") invoiceIds.push(e.invoiceId);
  }
  const [jobDocs, internalDocs, liveInvoices] = await Promise.all([
    jobIds.size ? db.getAll(...[...jobIds].map((id) => db.doc(`jobs/${id}`))) : Promise.resolve([]),
    internalIds.size
      ? db.getAll(...[...internalIds].map((id) => db.doc(`fieldInternalJobs/${id}`)))
      : Promise.resolve([]),
    existingInvoiceIds(invoiceIds),
  ]);
  const jobLabel = new Map<string, string>();
  const jobMeta = new Map<string, { title: string; number: string; kind: ProjectKind }>();
  for (const j of jobDocs) {
    if (j.exists && j.data()?.subAccountId === subAccountId) {
      jobLabel.set(j.id, `${j.data()?.number ?? ""} ${j.data()?.title ?? ""}`.trim());
      jobMeta.set(j.id, {
        title: String(j.data()?.title ?? ""),
        number: String(j.data()?.number ?? ""),
        kind: projectKindOf({ billingType: j.data()?.billingType, invoiceIds: j.data()?.invoiceIds }),
      });
    }
  }
  const internalLabel = new Map<string, string>();
  for (const j of internalDocs) {
    if (j.exists && j.data()?.subAccountId === subAccountId) internalLabel.set(j.id, String(j.data()?.name ?? ""));
  }

  const terms = jobTerms(config);
  const view = (id: string, e: Record<string, unknown>): CrewEntryView => {
    const jobId = typeof e.jobId === "string" ? e.jobId : null;
    const internalJobId = typeof e.internalJobId === "string" ? e.internalJobId : null;
    const visitId = typeof e.visitId === "string" ? e.visitId : null;
    const kind = String(e.kind ?? "general");
    let label = kind === "break" ? "Break" : "General time";
    if (jobId) label = jobLabel.get(jobId) ?? terms.Job;
    else if (internalJobId) label = internalLabel.get(internalJobId) ?? `Internal ${terms.job}`;
    const meta = jobId ? jobMeta.get(jobId) : undefined;
    const title = meta?.title || label;
    const number = meta?.number || null;
    const projectKind: ProjectKind | null = meta ? meta.kind : internalJobId ? "internal" : null;
    const invoiceId = typeof e.invoiceId === "string" ? e.invoiceId : null;
    return {
      id,
      startAt: iso(e.startAt),
      endAt: iso(e.endAt),
      running: e.running === true,
      kind,
      label,
      title,
      number,
      projectKind,
      target: visitId
        ? { type: "visit", id: visitId }
        : jobId
          ? { type: "job", id: jobId }
          : internalJobId
            ? { type: "internal", id: internalJobId }
            : { type: "none", id: null },
      note: typeof e.note === "string" ? e.note : "",
      billable: e.billable !== false,
      flagged: !!e.correctionRequest,
      hoursOnly: e.hoursOnly === true,
      invoiced: !!e.invoicedAt && (!invoiceId || liveInvoices.has(invoiceId)),
      locked: weekLocked || (!!e.invoicedAt && (!invoiceId || liveInvoices.has(invoiceId))),
      autoClosed: e.autoClosed === true,
    };
  };

  const nowMs = nowDate.getTime();
  let weekCount = 0;
  let weekRunning = false;
  const perDay = new Map<string, Span[]>();
  const allWeek: Span[] = [];
  const rowMap = new Map<string, { label: string; title: string; number: string | null; projectKind: ProjectKind | null; type: WeekRow["type"]; targetId: string | null; kind: string; hoursOnly: boolean; days: Map<string, Span[]>; all: Span[] }>();
  const dayEntries: CrewEntryView[] = [];
  const weekList: CrewEntryView[] = [];
  let running: CrewEntryView | null = null;
  for (const [id, e] of rows) {
    if (e.voided === true) continue;
    const start = ms(e.startAt);
    if (start === null) continue;
    const isRunning = e.running === true;
    const end = isRunning ? nowMs : ms(e.endAt);
    const key = zonedDateKey(new Date(start), timezone);
    if (isRunning) running = view(id, e);
    if (key >= weekStart && key < weekEnd) {
      weekCount++;
      if (isRunning) weekRunning = true;
      if (input.includeWeekEntries) weekList.push(view(id, e));
    }
    if (key >= weekStart && key < weekEnd && end !== null) {
      const list = perDay.get(key) ?? [];
      const fixed = e.hoursOnly === true;
      list.push([start, end, fixed]);
      perDay.set(key, list);
      allWeek.push([start, end, fixed]);
      const v = view(id, e);
      const type = v.target.type === "visit" ? "job" : v.target.type;
      const jobId = typeof e.jobId === "string" ? e.jobId : null;
      const internalJobId = typeof e.internalJobId === "string" ? e.internalJobId : null;
      const rowKey = jobId ? `job:${jobId}:${v.kind}` : internalJobId ? `internal:${internalJobId}:${v.kind}` : `none:${v.kind}`;
      const row = rowMap.get(rowKey) ?? { label: v.label, title: v.title, number: v.number, projectKind: v.projectKind, type, targetId: jobId ?? internalJobId, kind: v.kind, hoursOnly: fixed, days: new Map<string, Span[]>(), all: [] as Span[] };
      row.days.set(key, [...(row.days.get(key) ?? []), [start, end, fixed]]);
      row.all.push([start, end, fixed]);
      rowMap.set(rowKey, row);
    }
    if (key === date) dayEntries.push(view(id, e));
  }
  dayEntries.sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? ""));
  weekList.sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? ""));

  const week = Array.from({ length: 7 }, (_, i) => {
    const d = addDaysToKey(weekStart, i);
    return { date: d, ms: unionMs(perDay.get(d) ?? []) };
  });

  const order: Record<string, number> = { job: 0, internal: 1, none: 2 };
  const weekRows: WeekRow[] = [...rowMap.entries()]
    .map(([key, r]) => ({
      key,
      label: r.label,
      title: r.title,
      number: r.number,
      projectKind: r.projectKind,
      type: r.type,
      targetId: r.targetId,
      kind: r.kind,
      hoursOnly: r.hoursOnly,
      days: Array.from({ length: 7 }, (_, i) => unionMs(r.days.get(addDaysToKey(weekStart, i)) ?? [])),
      totalMs: unionMs(r.all),
    }))
    .sort((a, b) => (order[a.type] ?? 3) - (order[b.type] ?? 3) || a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind));

  return {
    enabled: true,
    workerId,
    timezone,
    now: nowDate.toISOString(),
    workday,
    running,
    date,
    entries: dayEntries,
    dayMs: week.find((w) => w.date === date)?.ms ?? 0,
    week,
    weekMs: unionMs(allWeek),
    sheet: {
      ...sheet,
      canSubmit: !weekLocked && weekCount > 0 && !weekRunning && weekClosable(weekStart, timezone),
    },
    targets,
    weekEntries: input.includeWeekEntries ? weekList : null,
    weekRows,
    expenses,
    expenseCurrency,
    submitButtonColor: config.submitButtonColor ?? "default",
    dayClock: config.dayClockEnabled === true,
    clock24: config.use24HourTime === true,
    timeKinds: config.timeKinds ?? DEFAULT_TIME_KINDS,
    jobWord: config.jobWord ?? "Job",
    jobWordPlural: config.jobWordPlural ?? "Jobs",
    activityWord: config.activityWord ?? "Activity",
  };
}

function cleanId(v: unknown): string {
  if (typeof v !== "string" || !ID.test(v)) throw new FieldServicesError("Choose where this time goes.");
  return v;
}

function cleanKind(v: unknown): JobTimeKind {
  if (typeof v !== "string" || !/^[a-z0-9_]{1,24}$/.test(v)) {
    throw new FieldServicesError("Choose what kind of time this is.");
  }
  return v as JobTimeKind;
}

/** Turns what the phone sent into a target, refusing anything that isn't exactly one of the known shapes. */
export function parseTarget(v: unknown): TimeTarget {
  if (!v || typeof v !== "object") throw new FieldServicesError("Choose where this time goes.");
  const t = v as Record<string, unknown>;
  switch (t.type) {
    case "visit":
      return { type: "visit", visitId: cleanId(t.visitId) };
    case "job":
      return { type: "job", jobId: cleanId(t.jobId), kind: cleanKind(t.kind) };
    case "internal":
      return { type: "internal", internalJobId: cleanId(t.internalJobId), kind: cleanKind(t.kind) };
    case "none":
      if (t.kind !== "general" && t.kind !== "break") {
        throw new FieldServicesError("Choose what kind of time this is.");
      }
      return { type: "none", kind: t.kind };
    default:
      throw new FieldServicesError("Choose where this time goes.");
  }
}

function sameTarget(e: Record<string, unknown>, t: TimeTarget): boolean {
  if (t.type === "job") return e.jobId === t.jobId && !e.visitId && e.kind === t.kind;
  if (t.type === "internal") return e.internalJobId === t.internalJobId && e.kind === t.kind;
  if (t.type === "none") return !e.jobId && !e.internalJobId && e.kind === t.kind;
  return false;
}

async function jobRecordsHoursOnly(subAccountId: string, jobId: string): Promise<boolean> {
  const snap = await getAdminDb().doc(`jobs/${jobId}`).get();
  return snap.exists && snap.data()?.subAccountId === subAccountId && snap.data()?.hoursOnly === true;
}

/**
 * Sets the hours for one row and day of the week grid: adds an entry in the first free time from 08:00,
 * changes a single entry, or removes it at zero. The normal time checks apply.
 */
async function setDayHours(input: {
  subAccountId: string;
  actor: FieldActor;
  target: TimeTarget;
  date: unknown;
  minutes: unknown;
  clientId?: unknown;
}): Promise<Record<string, unknown>> {
  const { subAccountId, actor, target } = input;
  const workerId = actor.workerId as string;
  if (typeof input.date !== "string" || !isDayKey(input.date)) throw new FieldServicesError("Pick a day.");
  const minutes = input.minutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 1_440) {
    throw new FieldServicesError("Enter hours between 0 and 24.");
  }
  if (target.type === "visit") throw new FieldServicesError("Time on a visit is changed from My day.");
  const date = input.date;
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const tzRaw = subSnap.data()?.timezone;
  const tz = typeof tzRaw === "string" && tzRaw ? tzRaw : "UTC";
  const from = zonedTimeToUtc(`${date}T00:00`, tz);
  const to = zonedTimeToUtc(`${addDaysToKey(date, 1)}T00:00`, tz);

  const live = (await entriesInRange(subAccountId, workerId, from, to)).filter((d) => d.data.voided !== true);
  const mine = live.filter((d) => sameTarget(d.data, target));
  if (mine.some((d) => d.data.running === true)) throw new FieldServicesError("Stop the timer first.", 409);
  if (mine.length > 1) {
    throw new FieldServicesError("This day has several entries for that row. Open the day to change them.", 409);
  }
  if (target.type === "job" && (await jobRecordsHoursOnly(subAccountId, target.jobId))) {
    // No clock times: the day just gets a length.
    if (mine.length === 1) {
      if (minutes === 0) await editOwnTimeEntry({ subAccountId, actor, entryId: mine[0].id, body: { void: true } });
      else await editOwnTimeEntry({ subAccountId, actor, entryId: mine[0].id, body: { durationMinutes: minutes } });
    } else if (minutes > 0) {
      await addHoursOnTarget({
        subAccountId,
        actor,
        target,
        date,
        minutes,
        clientId: typeof input.clientId === "string" ? input.clientId : undefined,
      });
    }
    return { ok: true };
  }
  if (mine.length === 1) {
    const e = mine[0];
    if (minutes === 0) {
      await editOwnTimeEntry({ subAccountId, actor, entryId: e.id, body: { void: true } });
      return { ok: true };
    }
    const start = ms(e.data.startAt);
    if (start === null) throw new FieldServicesError("That entry has no start time.", 409);
    await editOwnTimeEntry({
      subAccountId,
      actor,
      entryId: e.id,
      body: { startAt: new Date(start).toISOString(), endAt: new Date(start + minutes * 60_000).toISOString() },
    });
    return { ok: true };
  }
  if (minutes === 0) return { ok: true };

  const need = minutes * 60_000;
  const busy = live
    .filter((d) => d.data.hoursOnly !== true)
    .map((d) => [ms(d.data.startAt), d.data.running === true ? Date.now() : ms(d.data.endAt)] as const)
    .filter((b): b is readonly [number, number] => b[0] !== null && b[1] !== null)
    .sort((a, b) => a[0] - b[0]);
  const limit = Math.min(to.getTime(), Date.now());
  const findSlot = (startFrom: number): number | null => {
    let cursor = startFrom;
    for (const [bs, be] of busy) {
      if (cursor + need <= bs) break;
      cursor = Math.max(cursor, be);
    }
    return cursor + need <= limit ? cursor : null;
  };
  const eight = Math.max(zonedTimeToUtc(`${date}T08:00`, tz).getTime(), from.getTime());
  const slot = findSlot(eight) ?? findSlot(from.getTime());
  if (slot === null) {
    throw new FieldServicesError("There is no free time for that on that day. Open the day to change the other entries.", 409);
  }
  return {
    ...(await addTimeOnTarget({
      subAccountId,
      actor,
      target,
      startAt: new Date(slot).toISOString(),
      endAt: new Date(slot + need).toISOString(),
      clientId: typeof input.clientId === "string" ? input.clientId : undefined,
    })),
  };
}

/** The worker's own actions. `actor` must already be the signed-in worker, never office. */
export async function crewTimeAction(input: {
  subAccountId: string;
  actor: FieldActor;
  body: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { subAccountId, actor, body } = input;
  if (actor.isOffice || !actor.workerId) {
    throw new FieldServicesError("Only a worker with a profile can log time.", 403);
  }
  switch (body.action) {
    case "clock_in":
      return { ...(await clockIn({ subAccountId, actor })) };
    case "clock_out":
      await clockOut({ subAccountId, actor });
      return { ok: true };
    case "start":
      return { ...(await startTimeEntry({ subAccountId, actor, target: parseTarget(body.target) })) };
    case "stop":
      await stopEntry({ subAccountId, actor, entryId: cleanId(body.entryId) });
      return { ok: true };
    case "add":
      return {
        ...(await addTimeOnTarget({
          subAccountId,
          actor,
          target: parseTarget(body.target),
          startAt: body.startAt,
          endAt: body.endAt,
          note: typeof body.note === "string" ? body.note : undefined,
          clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        })),
      };
    case "set_day_hours":
      return {
        ...(await setDayHours({
          subAccountId,
          actor,
          target: parseTarget(body.target),
          date: body.date,
          minutes: body.minutes,
          clientId: body.clientId,
        })),
      };
    case "add_hours":
      return {
        ...(await addHoursOnTarget({
          subAccountId,
          actor,
          target: parseTarget(body.target),
          date: body.date,
          minutes: body.minutes,
          note: typeof body.note === "string" ? body.note : undefined,
          clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        })),
      };
    case "set_day_note":
      await setDayNote({ subAccountId, workerId: actor.workerId, date: body.date, note: body.note });
      return { ok: true };
    case "submit_week":
      await submitWeek({ subAccountId, workerId: actor.workerId, uid: actor.uid, weekStart: body.weekStart });
      return { ok: true };
    case "withdraw_week":
      await withdrawWeek({ subAccountId, workerId: actor.workerId, uid: actor.uid, weekStart: body.weekStart });
      return { ok: true };
    case "edit":
      await editOwnTimeEntry({
        subAccountId,
        actor,
        entryId: cleanId(body.entryId),
        body: {
          startAt: body.startAt,
          endAt: body.endAt,
          durationMinutes: body.durationMinutes,
          note: body.note,
          ...(body.target ? { target: parseTarget(body.target) } : {}),
        },
      });
      return { ok: true };
    case "add_expense":
      return { ...(await addExpense({ subAccountId, actor, body })) };
    case "edit_expense":
      await editExpense({ subAccountId, actor, expenseId: body.expenseId, body });
      return { ok: true };
    case "void_expense":
      await voidExpense({ subAccountId, actor, expenseId: body.expenseId });
      return { ok: true };
    case "void":
      await editOwnTimeEntry({ subAccountId, actor, entryId: cleanId(body.entryId), body: { void: true } });
      return { ok: true };
    default:
      throw new FieldServicesError("Unknown action.");
  }
}

