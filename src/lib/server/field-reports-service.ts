import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { unitToMinor } from "@/lib/field-services/money";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import type { Job, MaterialLine, TimeEntry, Visit } from "@/types/field-services";
import type { Quote } from "@/types/quotes";

const MAX_JOBS = 200;
const BATCH = 40;
const DAY = 86_400_000;

export interface FieldReport {
  days: number;
  requests: { created: number; converted: number };
  jobs: { created: number; completed: number; cancelled: number; avgDaysToComplete: number | null; capped: boolean };
  workers: { workerId: string; name: string; visitsCompleted: number; hours: number; billableHours: number }[];
  money: {
    currency: string;
    invoiced: number;
    paid: number;
    partsPrice: number;
    partsCost: number;
    onSiteConfirmed: number;
  }[];
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

/** Everything is counted for jobs created in the period, so a job's time, parts and invoices stay together. */
export async function fieldReport(subAccountId: string, days: number): Promise<FieldReport> {
  const db = getAdminDb();
  const since = Timestamp.fromMillis(Date.now() - days * DAY);

  const [jobSnap, requestSnap, workerSnap] = await Promise.all([
    db
      .collection("jobs")
      .where("subAccountId", "==", subAccountId)
      .where("createdAt", ">=", since)
      .orderBy("createdAt", "desc")
      .limit(MAX_JOBS + 1)
      .get(),
    db
      .collection("serviceRequests")
      .where("subAccountId", "==", subAccountId)
      .where("createdAt", ">=", since)
      .orderBy("createdAt", "desc")
      .limit(2_000)
      .get(),
    db.collection("fieldWorkers").where("subAccountId", "==", subAccountId).get(),
  ]);
  const capped = jobSnap.size > MAX_JOBS;
  const jobs = jobSnap.docs.slice(0, MAX_JOBS).map((d) => ({ ...d.data(), id: d.id }) as Job);
  const names = new Map(workerSnap.docs.map((d) => [d.id, (d.data().name as string) ?? "Worker"]));

  const requests = requestSnap.docs;

  const perJob = await inBatches(jobs, async (job) => {
    const [visits, time, parts, pays] = await Promise.all([
      db.collection("visits").where("jobId", "==", job.id).get(),
      db.collection("timeEntries").where("jobId", "==", job.id).get(),
      db.collection("materialLines").where("jobId", "==", job.id).get(),
      db.collection("jobPayments").where("jobId", "==", job.id).get(),
    ]);
    const invoiceIds = job.invoiceIds ?? [];
    const quotes: FirebaseFirestore.DocumentSnapshot[] = [];
    for (let i = 0; i < invoiceIds.length; i += 100) {
      quotes.push(...(await db.getAll(...invoiceIds.slice(i, i + 100).map((id) => db.doc(`quotes/${id}`)))));
    }
    return { job, visits, time, parts, pays, quotes };
  });

  const workerStats = new Map<string, { visits: number; hours: number; billable: number }>();
  const stat = (id: string) => {
    if (!workerStats.has(id)) workerStats.set(id, { visits: 0, hours: 0, billable: 0 });
    return workerStats.get(id)!;
  };
  const money = new Map<string, FieldReport["money"][number]>();
  const cur = (currency: string) => {
    if (!money.has(currency)) {
      money.set(currency, { currency, invoiced: 0, paid: 0, partsPrice: 0, partsCost: 0, onSiteConfirmed: 0 });
    }
    return money.get(currency)!;
  };

  let completed = 0;
  let cancelled = 0;
  let totalDays = 0;
  let timed = 0;
  for (const { job, visits, time, parts, pays, quotes } of perJob) {
    const m = cur(job.currency);
    if (job.status === "cancelled") cancelled++;
    if (job.status === "ready_to_invoice" || job.status === "closed") {
      completed++;
      const done = ms(job.completedAt);
      const made = ms(job.createdAt);
      if (done && made && done >= made) {
        totalDays += (done - made) / DAY;
        timed++;
      }
    }
    for (const d of visits.docs) {
      const v = d.data() as Visit;
      if (v.status !== "completed") continue;
      for (const w of v.workerIds) stat(w).visits++;
    }
    for (const d of time.docs) {
      const e = d.data() as TimeEntry;
      if (e.voided === true || e.running) continue;
      const hours = Math.max(0, (ms(e.endAt) - ms(e.startAt)) / 3_600_000);
      const s = stat(e.workerId);
      s.hours += hours;
      if (e.billable !== false) s.billable += hours;
    }
    for (const d of parts.docs) {
      const p = d.data() as MaterialLine;
      m.partsPrice += Math.round(p.qty * (p.unitPriceMinor ?? 0));
      m.partsCost += Math.round(p.qty * (p.unitCostMinor ?? 0));
    }
    for (const d of pays.docs) {
      if (d.data().status === "confirmed") m.onSiteConfirmed += (d.data().amountMinor as number) ?? 0;
    }
    for (const q of quotes) {
      const quote = q.data() as Quote | undefined;
      if (!quote || quote.subAccountId !== subAccountId || quote.kind !== "invoice") continue;
      if (!["sent", "viewed", "accepted", "paid"].includes(quote.status)) continue;
      const total = unitToMinor(quote.currency, computeQuoteTotals(quote).total);
      const qm = cur(quote.currency);
      qm.invoiced += total;
      if (quote.status === "paid") qm.paid += total;
    }
  }

  return {
    days,
    requests: {
      created: requests.length,
      converted: requests.filter((d) => d.data().status === "converted").length,
    },
    jobs: {
      created: jobs.length,
      completed,
      cancelled,
      avgDaysToComplete: timed ? Math.round((totalDays / timed) * 10) / 10 : null,
      capped,
    },
    workers: [...workerStats.entries()]
      .map(([workerId, s]) => ({
        workerId,
        name: names.get(workerId) ?? "Removed worker",
        visitsCompleted: s.visits,
        hours: Math.round(s.hours * 100) / 100,
        billableHours: Math.round(s.billable * 100) / 100,
      }))
      .sort((a, b) => b.hours - a.hours),
    money: [...money.values()].filter(
      (m) => m.invoiced || m.paid || m.partsPrice || m.partsCost || m.onSiteConfirmed,
    ),
  };
}
