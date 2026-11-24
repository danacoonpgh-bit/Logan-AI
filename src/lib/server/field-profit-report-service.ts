import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { unitToMinor } from "@/lib/field-services/money";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { listWorkerRates } from "@/lib/server/field-worker-rates-service";
import type { Job, MaterialLine, TimeEntry } from "@/types/field-services";
import type { Quote } from "@/types/quotes";

const MAX_JOBS = 200;
const BATCH = 40;
const DAY = 86_400_000;

export interface ProfitRow {
  jobId: string;
  number: string;
  title: string;
  status: string;
  billingType: string | null;
  currency: string;
  /** The one service on the project, or empty when it has none or several. */
  service: string;
  revenueMinor: number;
  labourHours: number;
  labourCostMinor: number;
  /** Hours with no cost rate (or a rate in another currency), so not in the cost. */
  unpricedHours: number;
  partsCostMinor: number;
  expensesMinor: number;
  marginMinor: number;
}

export interface ServiceProfit {
  service: string;
  currency: string;
  jobs: number;
  revenueMinor: number;
  costMinor: number;
  marginMinor: number;
}

export interface ProfitReport {
  days: number;
  capped: boolean;
  rows: ProfitRow[];
  services: ServiceProfit[];
}

function ms(v: unknown): number {
  return (v as Timestamp | undefined)?.toMillis?.() ?? 0;
}

async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + BATCH).map(fn))));
  }
  return out;
}

/**
 * Per project created in the period: revenue (invoices without tax), labour at cost rate, parts cost and expenses,
 * and the same by service. Admin only, it holds pay figures.
 */
export async function fieldProfitReport(subAccountId: string, days: number): Promise<ProfitReport> {
  const db = getAdminDb();
  const since = Timestamp.fromMillis(Date.now() - days * DAY);
  const [jobSnap, rates] = await Promise.all([
    db
      .collection("jobs")
      .where("subAccountId", "==", subAccountId)
      .where("createdAt", ">=", since)
      .orderBy("createdAt", "desc")
      .limit(MAX_JOBS + 1)
      .get(),
    listWorkerRates(subAccountId),
  ]);
  const capped = jobSnap.size > MAX_JOBS;
  const jobs = jobSnap.docs.slice(0, MAX_JOBS).map((d) => ({ ...d.data(), id: d.id }) as Job);

  const productIds = [...new Set(jobs.flatMap((j) => j.lineItems.map((l) => l.productId).filter((id): id is string => !!id)))];
  const serviceName = new Map<string, string>();
  for (let i = 0; i < productIds.length; i += 100) {
    const docs = await db.getAll(...productIds.slice(i, i + 100).map((id) => db.doc(`products/${id}`)));
    for (const d of docs) {
      if (d.exists && d.data()?.subAccountId === subAccountId && d.data()?.kind === "service") {
        serviceName.set(d.id, String(d.data()?.name ?? "Service"));
      }
    }
  }

  const perJob = await inBatches(jobs, async (job) => {
    const [time, parts, expenses] = await Promise.all([
      db.collection("timeEntries").where("jobId", "==", job.id).get(),
      db.collection("materialLines").where("jobId", "==", job.id).get(),
      db.collection("fieldExpenses").where("jobId", "==", job.id).get(),
    ]);
    const invoiceIds = job.invoiceIds ?? [];
    const quotes: FirebaseFirestore.DocumentSnapshot[] = [];
    for (let i = 0; i < invoiceIds.length; i += 100) {
      quotes.push(...(await db.getAll(...invoiceIds.slice(i, i + 100).map((id) => db.doc(`quotes/${id}`)))));
    }
    return { job, time, parts, expenses, quotes };
  });

  const rows: ProfitRow[] = perJob.map(({ job, time, parts, expenses, quotes }) => {
    let revenue = 0;
    for (const q of quotes) {
      const quote = q.data() as Quote | undefined;
      if (!quote || quote.subAccountId !== subAccountId || quote.kind !== "invoice" || quote.currency !== job.currency) continue;
      if (!["sent", "viewed", "accepted", "paid"].includes(quote.status)) continue;
      const t = computeQuoteTotals(quote);
      revenue += unitToMinor(quote.currency, t.total - t.taxAmount);
    }
    // A deposit paid at booking is revenue that no invoice total carries any more.
    // The deposit was paid with tax, which is not revenue.
    revenue += Math.round((job.depositPaidMinor ?? 0) / (job.tax && job.tax.percent > 0 ? 1 + job.tax.percent / 100 : 1));
    let hours = 0;
    let unpriced = 0;
    let labourCost = 0;
    for (const d of time.docs) {
      const e = d.data() as TimeEntry;
      if (e.subAccountId !== subAccountId || e.voided === true || e.running) continue;
      const h = Math.max(0, (ms(e.endAt) - ms(e.startAt)) / 3_600_000);
      hours += h;
      const r = rates.get(e.workerId);
      if (r && r.costRateMinor > 0 && r.currency === job.currency) labourCost += Math.round(h * r.costRateMinor);
      else unpriced += h;
    }
    let partsCost = 0;
    for (const d of parts.docs) {
      const p = d.data() as MaterialLine;
      if (p.subAccountId !== subAccountId) continue;
      partsCost += Math.round(p.qty * (p.unitCostMinor ?? 0));
    }
    let expensesMinor = 0;
    for (const d of expenses.docs) {
      const e = d.data();
      if (e.subAccountId !== subAccountId || e.voided === true || e.currency !== job.currency) continue;
      expensesMinor += Number(e.amountMinor) || 0;
    }
    const ids = [...new Set(job.lineItems.map((l) => l.productId).filter((id): id is string => !!id && serviceName.has(id)))];
    return {
      jobId: job.id,
      number: job.number,
      title: job.title,
      status: job.status,
      billingType: job.billingType ?? null,
      currency: job.currency,
      service: ids.length === 1 ? (serviceName.get(ids[0]) ?? "") : "",
      revenueMinor: revenue,
      labourHours: Math.round(hours * 100) / 100,
      labourCostMinor: labourCost,
      unpricedHours: Math.round(unpriced * 100) / 100,
      partsCostMinor: partsCost,
      expensesMinor,
      marginMinor: revenue - labourCost - partsCost - expensesMinor,
    };
  });

  const bucket = new Map<string, ServiceProfit>();
  for (const r of rows) {
    const key = `${r.currency}|${r.service}`;
    const b = bucket.get(key) ?? { service: r.service, currency: r.currency, jobs: 0, revenueMinor: 0, costMinor: 0, marginMinor: 0 };
    b.jobs += 1;
    b.revenueMinor += r.revenueMinor;
    b.costMinor += r.labourCostMinor + r.partsCostMinor + r.expensesMinor;
    b.marginMinor += r.marginMinor;
    bucket.set(key, b);
  }

  return {
    days,
    capped,
    rows: rows.sort((a, b) => b.number.localeCompare(a.number)),
    services: [...bucket.values()].sort((a, b) => b.marginMinor - a.marginMinor),
  };
}
