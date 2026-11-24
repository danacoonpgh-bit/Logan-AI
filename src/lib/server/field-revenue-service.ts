import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { kindLabelOf } from "@/lib/field-services/time-kinds";
import { effectiveBillingType } from "@/lib/field-services/billing-type";
import { priceLabour, type LabourEntry, type LabourRate } from "@/lib/field-services/labour-pricing";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { existingInvoiceIds, legacyBilledApprovals } from "@/lib/server/field-invoicing";
import { listWorkerRates } from "@/lib/server/field-worker-rates-service";
import { approvedWeeks, weekStartOf, workspaceTimezone } from "@/lib/server/field-timesheet-service";
import type { Job, JobBillingType, RateCard } from "@/types/field-services";

export interface RevenueLine {
  id: string;
  description: string;
  quantity: number;
  totalMinor: number;
  extraWork: boolean;
  invoiced: boolean;
}

export interface RevenueLabourRow {
  workerId: string;
  workerName: string;
  activity: string;
  hours: number;
  valueMinor: number;
  /** Hours in a week whose timesheet is not approved yet, so an invoice would leave them out. */
  waitingHours: number;
}

export interface RevenuePart {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  totalMinor: number;
  invoiced: boolean;
}

export interface JobRevenue {
  currency: string;
  billingType: JobBillingType;
  wip: boolean;
  lines: RevenueLine[];
  /** Null on a Fixed price project: its time is for cost reporting only. */
  labour: { rows: RevenueLabourRow[]; hours: number; valueMinor: number; missingRate: string[] } | null;
  parts: RevenuePart[];
  /** Always the whole project, whatever the filter shows. */
  totals: { invoicedMinor: number; wipMinor: number; totalMinor: number };
  /** Time and materials only: the project's estimate, or null when none was entered. */
  estimateMinor: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** What a project has earned so far, split into what is on an invoice and what is still work in progress. */
export async function jobRevenue(input: { subAccountId: string; jobId: string; wip: boolean }): Promise<JobRevenue> {
  const db = getAdminDb();
  const snap = await db.doc(`jobs/${input.jobId}`).get();
  if (!snap.exists || snap.data()?.subAccountId !== input.subAccountId) throw new FieldServicesError("Not found.", 404);
  const job = { id: snap.id, ...snap.data() } as Job;
  const billingType: JobBillingType = effectiveBillingType(job);
  const lump = billingType === "lump_sum";
  const config = await getFieldServicesConfig(input.subAccountId);

  const [timeSnap, partSnap, legacy] = await Promise.all([
    lump ? null : db.collection("timeEntries").where("jobId", "==", job.id).get(),
    db.collection("materialLines").where("jobId", "==", job.id).get(),
    legacyBilledApprovals(job),
  ]);

  const ids: (string | null | undefined)[] = [
    ...Object.values(job.billedApprovals ?? {}),
    job.billedLinesInvoiceId,
    ...(job.billedLinesInvoiceId ? [] : (job.invoiceIds ?? [])),
  ];
  for (const d of timeSnap?.docs ?? []) ids.push(d.data().invoiceId as string | undefined);
  for (const d of partSnap.docs) ids.push(d.data().invoiceLineId as string | undefined);
  const alive = await existingInvoiceIds(ids);

  // charge lines, including approved extra work
  const ownBilled = job.billedLinesInvoiceId
    ? alive.has(job.billedLinesInvoiceId)
    : job.billedLinesInvoiceId === undefined && (job.invoiceIds ?? []).some((i) => alive.has(i));
  const allLines: RevenueLine[] = (job.lineItems ?? [])
    .filter((l) => l.quantity * l.unitPriceMinor > 0)
    .map((l) => {
      let invoiced: boolean;
      if (!l.approvalId) invoiced = ownBilled && job.jobType !== "recurring";
      else {
        const inv = job.billedApprovals?.[l.approvalId];
        invoiced = Boolean((inv && alive.has(inv)) || (!inv && legacy.has(l.approvalId)));
      }
      return {
        id: l.id,
        description: l.description,
        quantity: l.quantity,
        totalMinor: Math.round(l.quantity * l.unitPriceMinor),
        extraWork: Boolean(l.approvalId),
        invoiced,
      };
    });

  // parts that would reach an invoice
  const allParts: RevenuePart[] = partSnap.docs
    .filter((d) => d.data().subAccountId === job.subAccountId && d.data().billable !== false && Number(d.data().unitPriceMinor) > 0)
    .map((d) => {
      const m = d.data();
      return {
        id: d.id,
        name: String(m.name ?? ""),
        quantity: Number(m.qty) || 0,
        unit: String(m.unit ?? ""),
        totalMinor: Math.round((Number(m.qty) || 0) * Number(m.unitPriceMinor)),
        invoiced: Boolean(m.invoiceLineId && alive.has(m.invoiceLineId as string)),
      };
    });

  // billable time, valued at each person's sell rate
  let labour: JobRevenue["labour"] = null;
  let labourInvoiced = 0;
  let labourWip = 0;
  if (!lump) {
    const tz = await workspaceTimezone(job.subAccountId);
    const [workerDocs, cardDocs, ownRates] = await Promise.all([
      db.collection("fieldWorkers").where("subAccountId", "==", job.subAccountId).get(),
      db.collection("fieldRateCards").where("subAccountId", "==", job.subAccountId).get(),
      listWorkerRates(job.subAccountId),
    ]);
    const names = new Map(workerDocs.docs.map((w) => [w.id, String(w.data().name ?? "Staff")]));
    const cardOf = new Map(workerDocs.docs.map((w) => [w.id, (w.data().rateCardId as string | null | undefined) ?? null]));
    const cards = new Map(cardDocs.docs.map((c) => [c.id, { id: c.id, ...c.data() } as RateCard]));
    const rateFor = (workerId: string): LabourRate | null => {
      const card = cards.get(cardOf.get(workerId) ?? "");
      const own = ownRates.get(workerId);
      if (own && own.sellRateMinor > 0) {
        return { hourlyMinor: own.sellRateMinor, dayMinor: card ? card.dayRateMinor : null, role: card?.name ?? "" };
      }
      return card ? { hourlyMinor: card.hourlyRateMinor, dayMinor: card.dayRateMinor, role: card.name } : null;
    };

    interface Booked extends LabourEntry {
      kind: string;
      invoiced: boolean;
    }
    const booked: Booked[] = [];
    for (const d of timeSnap?.docs ?? []) {
      const e = d.data();
      if (e.subAccountId !== job.subAccountId || e.voided === true || e.billable === false || e.running) continue;
      const s = (e.startAt as { toMillis?: () => number } | null)?.toMillis?.();
      const en = (e.endAt as { toMillis?: () => number } | null)?.toMillis?.();
      if (!s || !en || en <= s) continue;
      booked.push({
        workerId: String(e.workerId),
        startMs: s,
        endMs: en,
        fixed: e.hoursOnly === true,
        kind: String(e.kind ?? "general"),
        invoiced: Boolean(e.invoiceId && alive.has(e.invoiceId as string)),
      });
    }
    const billed = booked.filter((b) => b.invoiced);
    const open = booked.filter((b) => !b.invoiced);
    const nameFor = (id: string) => names.get(id) ?? "Staff";
    const priceOf = (entries: LabourEntry[], prior: LabourEntry[]) => {
      const res = priceLabour({ billingType, timezone: job.timezone, entries, prior, rateFor, nameFor });
      const perWorker = new Map<string, number>();
      for (const l of res.lines) perWorker.set(l.workerId, (perWorker.get(l.workerId) ?? 0) + Math.round(l.quantity * l.unitPriceMinor));
      return { perWorker, missing: res.missingRate.concat(res.missingDayRate) };
    };
    const billedPrice = priceOf(billed, []);
    const openPrice = priceOf(open, billed);
    labourInvoiced = [...billedPrice.perWorker.values()].reduce((a, b) => a + b, 0);
    labourWip = [...openPrice.perWorker.values()].reduce((a, b) => a + b, 0);

    // approval: invoices only bill approved weeks
    const timesheets = config.timesheetsEnabled === true;
    const firstMs = (config.timesheetsFirstEnabledAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? null;
    const legacyBefore = firstMs === null ? null : weekStartOf(firstMs, tz);
    const approved = timesheets
      ? await approvedWeeks(job.subAccountId, open.map((o) => ({ workerId: o.workerId, weekStart: weekStartOf(o.startMs, tz) })))
      : null;
    const isWaiting = (o: Booked) => {
      if (!approved) return false;
      const week = weekStartOf(o.startMs, tz);
      if (legacyBefore !== null && week < legacyBefore) return false;
      return !approved.has(`${o.workerId}|${week}`);
    };

    // value of each person is shared across their activities by hours
    const shown = input.wip ? open : booked;
    const hoursBy = new Map<string, Map<string, { hours: number; waiting: number }>>();
    const workerHours = new Map<string, number>();
    for (const b of shown) {
      const h = (b.endMs - b.startMs) / 3_600_000;
      const kinds = hoursBy.get(b.workerId) ?? new Map();
      const cur = kinds.get(b.kind) ?? { hours: 0, waiting: 0 };
      cur.hours += h;
      if (!b.invoiced && isWaiting(b)) cur.waiting += h;
      kinds.set(b.kind, cur);
      hoursBy.set(b.workerId, kinds);
      workerHours.set(b.workerId, (workerHours.get(b.workerId) ?? 0) + h);
    }
    const rows: RevenueLabourRow[] = [];
    for (const [workerId, kinds] of hoursBy) {
      const value = input.wip
        ? (openPrice.perWorker.get(workerId) ?? 0)
        : (billedPrice.perWorker.get(workerId) ?? 0) + (openPrice.perWorker.get(workerId) ?? 0);
      const total = workerHours.get(workerId) ?? 0;
      for (const [kind, v] of kinds) {
        rows.push({
          workerId,
          workerName: nameFor(workerId),
          activity: kindLabelOf(config.timeKinds, kind),
          hours: round2(v.hours),
          valueMinor: total > 0 ? Math.round((value * v.hours) / total) : 0,
          waitingHours: round2(v.waiting),
        });
      }
    }
    rows.sort((a, b) => a.workerName.localeCompare(b.workerName) || a.activity.localeCompare(b.activity));
    labour = {
      rows,
      hours: round2(rows.reduce((n, r) => n + r.hours, 0)),
      valueMinor: rows.reduce((n, r) => n + r.valueMinor, 0),
      missingRate: [...new Set([...billedPrice.missing, ...openPrice.missing])].map(nameFor),
    };
  }

  const linesShown = input.wip ? allLines.filter((l) => !l.invoiced) : allLines;
  const partsShown = input.wip ? allParts.filter((p) => !p.invoiced) : allParts;
  const invoicedMinor =
    allLines.filter((l) => l.invoiced).reduce((n, l) => n + l.totalMinor, 0) +
    allParts.filter((p) => p.invoiced).reduce((n, p) => n + p.totalMinor, 0) +
    labourInvoiced;
  const wipMinor =
    allLines.filter((l) => !l.invoiced).reduce((n, l) => n + l.totalMinor, 0) +
    allParts.filter((p) => !p.invoiced).reduce((n, p) => n + p.totalMinor, 0) +
    labourWip;

  return {
    currency: job.currency,
    billingType,
    wip: input.wip,
    lines: linesShown,
    labour,
    parts: partsShown,
    totals: { invoicedMinor, wipMinor, totalMinor: invoicedMinor + wipMinor },
    estimateMinor:
      billingType === "time_and_materials" && (job.estimateLines?.length ?? 0) > 0
        ? job.estimateLines!.reduce((n, l) => n + Math.round(l.quantity * l.unitPriceMinor), 0)
        : null,
  };
}
