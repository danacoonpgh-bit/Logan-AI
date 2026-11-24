import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { effectiveBillingType } from "@/lib/field-services/billing-type";
import { mondayOf } from "@/lib/field-services/intervals";
import { addDaysToKey, zonedDateKey } from "@/lib/field-services/time";
import { inWeekRange, parseWeekRange } from "@/lib/field-services/week-range";
import { createDocumentFromJob } from "@/lib/server/field-documents-service";
import { existingInvoiceIds, legacyBilledApprovals } from "@/lib/server/field-invoicing";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { weekStartOf, workspaceTimezone } from "@/lib/server/field-timesheet-service";
import type { Job, JobBillingType } from "@/types/field-services";

const OPEN_STATUSES = ["unscheduled", "scheduled", "in_progress", "ready_to_invoice", "action_required"];
const MAX_JOBS = 200;
const MAX_RUN = 25;
const WEEK_CHOICES = 12;
const ID = /^[A-Za-z0-9_-]{6,80}$/;

export interface InvoiceRunRow {
  jobId: string;
  number: string;
  title: string;
  contactName: string;
  billingType: JobBillingType;
  currency: string;
  status: Job["status"];
  /** Hours in approved weeks that no invoice carries yet. */
  approvedHours: number;
  /** Hours in weeks the crew submitted that wait for approval. */
  awaitingHours: number;
  /** Hours in weeks nobody has submitted or approved. */
  notSubmittedHours: number;
  parts: number;
  /** The project's own lines, or extra work the customer approved, are not on an invoice yet. */
  ownLines: boolean;
  ready: boolean;
}

export interface InvoiceRunPreview {
  timezone: string;
  /** The Monday of each recent week, newest first. */
  weeks: string[];
  weekEnding: string;
  rows: InvoiceRunRow[];
  repeatingSkipped: number;
  truncated: boolean;
}

export interface InvoiceRunResult {
  jobId: string;
  ok: boolean;
  id?: string;
  quoteNumber?: string;
  hoursBilled?: number;
  partsBilled?: number;
  hoursWaiting?: number;
  error?: string;
}

function weekChoices(timezone: string): string[] {
  const monday = mondayOf(zonedDateKey(new Date(), timezone));
  return Array.from({ length: WEEK_CHOICES }, (_, i) => addDaysToKey(monday, -7 * i));
}

export async function invoiceRunWeeks(subAccountId: string): Promise<{ timezone: string; weeks: string[] }> {
  const timezone = await workspaceTimezone(subAccountId);
  return { timezone, weeks: weekChoices(timezone) };
}

async function requireTimesheets(subAccountId: string) {
  const config = await getFieldServicesConfig(subAccountId);
  if (!config.timesheetsEnabled) {
    throw new FieldServicesError("Turn on timesheets in Settings first. An invoice run bills approved timesheet weeks.", 409);
  }
  return config;
}

function hours(startAt: unknown, endAt: unknown): number {
  const s = (startAt as { toMillis?: () => number } | null)?.toMillis?.();
  const e = (endAt as { toMillis?: () => number } | null)?.toMillis?.();
  return s && e && e > s ? (e - s) / 3_600_000 : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What each open project could bill for the chosen weeks, split by whether the time is approved yet. */
export async function previewInvoiceRun(input: {
  subAccountId: string;
  weekEnding?: unknown;
  weeks?: unknown;
  /** Count logged parts. Off when the run will leave them off. */
  includeParts?: boolean;
}): Promise<InvoiceRunPreview> {
  const config = await requireTimesheets(input.subAccountId);
  const timezone = await workspaceTimezone(input.subAccountId);
  const choices = weekChoices(timezone);
  const parsed = parseWeekRange(input.weekEnding || choices[1], input.weeks);
  if (!parsed.ok || !parsed.range) throw new FieldServicesError(parsed.ok ? "Choose a week ending." : parsed.error);
  const range = parsed.range;
  const db = getAdminDb();

  const jobSnap = await db
    .collection("jobs")
    .where("subAccountId", "==", input.subAccountId)
    .where("status", "in", OPEN_STATUSES)
    .limit(MAX_JOBS + 1)
    .get();
  const truncated = jobSnap.size > MAX_JOBS;
  const jobs = jobSnap.docs.slice(0, MAX_JOBS).map((d) => ({ ...(d.data() as Job), id: d.id }));
  const targets = jobs.filter((j) => j.jobType !== "recurring");

  type Snap = FirebaseFirestore.QueryDocumentSnapshot;
  const loaded: { job: Job; entries: Snap[]; parts: Snap[]; legacy: Set<string> }[] = [];
  for (let i = 0; i < targets.length; i += 10) {
    loaded.push(
      ...(await Promise.all(
        targets.slice(i, i + 10).map(async (job) => {
          const lump = effectiveBillingType(job) === "lump_sum";
          const [t, p, legacy] = await Promise.all([
            lump ? null : db.collection("timeEntries").where("jobId", "==", job.id).get(),
            input.includeParts === false ? null : db.collection("materialLines").where("jobId", "==", job.id).get(),
            legacyBilledApprovals(job),
          ]);
          return { job, entries: t?.docs ?? [], parts: p?.docs ?? [], legacy };
        }),
      )),
    );
  }

  const ids = new Set<string>();
  for (const { job, entries, parts } of loaded) {
    for (const v of Object.values(job.billedApprovals ?? {})) ids.add(v);
    if (job.billedLinesInvoiceId) ids.add(job.billedLinesInvoiceId);
    else for (const v of job.invoiceIds ?? []) ids.add(v);
    for (const d of entries) if (d.data().invoiceId) ids.add(d.data().invoiceId as string);
    for (const d of parts) if (d.data().invoiceLineId) ids.add(d.data().invoiceLineId as string);
  }
  const alive = await existingInvoiceIds([...ids]);

  const firstEnabledMs =
    (config.timesheetsFirstEnabledAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? null;
  const legacyBefore = firstEnabledMs === null ? null : weekStartOf(firstEnabledMs, timezone);

  type Eligible = { workerId: string; week: string; h: number };
  const perJob = new Map<string, Eligible[]>();
  const sheetKeys = new Map<string, { workerId: string; week: string }>();
  for (const { job, entries } of loaded) {
    const list: Eligible[] = [];
    for (const d of entries) {
      const e = d.data();
      if (e.subAccountId !== input.subAccountId || e.voided === true || e.billable === false || e.running) continue;
      if (e.invoiceId && alive.has(e.invoiceId as string)) continue;
      const h = hours(e.startAt, e.endAt);
      if (h <= 0) continue;
      const week = weekStartOf((e.startAt as { toMillis: () => number }).toMillis(), timezone);
      if (!inWeekRange(week, range) || !ID.test(e.workerId as string)) continue;
      list.push({ workerId: e.workerId as string, week, h });
      sheetKeys.set(`${e.workerId}|${week}`, { workerId: e.workerId as string, week });
    }
    perJob.set(job.id, list);
  }

  const status = new Map<string, string>();
  const refs = [...sheetKeys.values()].map((k) => db.doc(`fieldTimesheets/${k.workerId}_${k.week}`));
  for (let i = 0; i < refs.length; i += 100) {
    const snaps = await db.getAll(...refs.slice(i, i + 100));
    for (const s of snaps) {
      const d = s.data();
      if (s.exists && d?.subAccountId === input.subAccountId) status.set(s.id, String(d.status));
    }
  }

  const rows: InvoiceRunRow[] = [];
  for (const { job, parts, legacy } of loaded) {
    const billingType: JobBillingType = effectiveBillingType(job);
    let approved = 0;
    let awaiting = 0;
    let notSubmitted = 0;
    for (const e of perJob.get(job.id) ?? []) {
      const st = status.get(`${e.workerId}_${e.week}`);
      if (st === "approved" || (legacyBefore !== null && e.week < legacyBefore)) approved += e.h;
      else if (st === "submitted") awaiting += e.h;
      else notSubmitted += e.h;
    }
    const partCount = parts.filter((d) => {
      const m = d.data();
      if (m.subAccountId !== input.subAccountId || m.billable === false) return false;
      if (m.invoiceLineId && alive.has(m.invoiceLineId as string)) return false;
      const t = (m.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.();
      return t === undefined || inWeekRange(weekStartOf(t, timezone), range);
    }).length;
    const ownLinesBilled = job.billedLinesInvoiceId
      ? alive.has(job.billedLinesInvoiceId)
      : job.billedLinesInvoiceId === undefined && (job.invoiceIds ?? []).some((i) => alive.has(i));
    const ownLines = (job.lineItems ?? []).some((l) =>
      l.approvalId
        ? !(job.billedApprovals?.[l.approvalId] && alive.has(job.billedApprovals[l.approvalId])) &&
          !(!job.billedApprovals?.[l.approvalId] && legacy.has(l.approvalId))
        : !ownLinesBilled,
    );
    const lump = billingType === "lump_sum";
    if (approved + awaiting + notSubmitted === 0 && partCount === 0 && !(lump && ownLines)) continue;
    rows.push({
      jobId: job.id,
      number: job.number,
      title: job.title,
      contactName: job.contactName ?? "",
      billingType,
      currency: job.currency,
      status: job.status,
      approvedHours: round2(approved),
      awaitingHours: round2(awaiting),
      notSubmittedHours: round2(notSubmitted),
      parts: partCount,
      ownLines,
      ready: approved > 0 || partCount > 0 || (lump && ownLines && job.status === "ready_to_invoice"),
    });
  }
  rows.sort((a, b) => a.contactName.localeCompare(b.contactName) || a.number.localeCompare(b.number));

  return {
    timezone,
    weeks: choices,
    weekEnding: range.to,
    rows,
    repeatingSkipped: jobs.length - targets.length,
    truncated,
  };
}

/** Drafts one invoice for each chosen project. A project that can't be billed is reported and the rest carry on. */
export async function runInvoices(input: {
  subAccountId: string;
  createdByUid: string;
  weekEnding: unknown;
  weeks: unknown;
  jobIds: unknown;
  includeParts: boolean;
}): Promise<InvoiceRunResult[]> {
  await requireTimesheets(input.subAccountId);
  const parsed = parseWeekRange(input.weekEnding, input.weeks);
  if (!parsed.ok || !parsed.range) throw new FieldServicesError(parsed.ok ? "Choose a week ending." : parsed.error);
  if (!Array.isArray(input.jobIds) || input.jobIds.length === 0) {
    throw new FieldServicesError("Choose at least one project.");
  }
  const jobIds = [...new Set(input.jobIds.filter((j): j is string => typeof j === "string" && ID.test(j)))];
  if (jobIds.length === 0) throw new FieldServicesError("Choose at least one project.");
  if (jobIds.length > MAX_RUN) throw new FieldServicesError(`Draft up to ${MAX_RUN} invoices at a time.`);

  const weeks = typeof input.weeks === "number" ? input.weeks : null;
  const results: InvoiceRunResult[] = [];
  for (const jobId of jobIds) {
    try {
      const doc = await createDocumentFromJob({
        subAccountId: input.subAccountId,
        jobId,
        kind: "invoice",
        createdByUid: input.createdByUid,
        options: {
          includeParts: input.includeParts,
          includeLabour: true,
          weekEnding: parsed.range.to,
          weeks,
        },
      });
      results.push({
        jobId,
        ok: true,
        id: doc.id,
        quoteNumber: doc.quoteNumber,
        hoursBilled: doc.hoursBilled,
        partsBilled: doc.partsBilled,
        hoursWaiting: doc.hoursWaiting,
      });
    } catch (err) {
      results.push({
        jobId,
        ok: false,
        error: err instanceof FieldServicesError ? err.message : "That one didn't work. Try it from the project.",
      });
      if (!(err instanceof FieldServicesError)) console.warn("[field-invoice-run] draft failed", err);
    }
  }
  return results;
}
