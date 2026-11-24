import "server-only";

import { notesForWorker } from "@/lib/server/field-job-notes-service";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { effectiveBillingType } from "@/lib/field-services/billing-type";
import { formatServiceAddress } from "@/lib/field-services/address";
import { workerForUid } from "@/lib/server/field-access";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { jobTerms } from "@/lib/field-services/terms";
import { tsToIso } from "@/lib/server/field-events";
import type {
  ChecklistItem,
  Job,
  JobPayment,
  MaterialLine,
  PhotoRef,
  TimeEntry,
  Visit,
} from "@/types/field-services";

export interface TodayVisit {
  subAccountId: string;
  subAccountName: string;
  /** The workspace's own word for a job, so the crew screen reads like the office's. */
  jobWord: string;
  jobWordPlural: string;
  clock24: boolean;
  visit: {
    id: string;
    status: Visit["status"];
    scheduledStart: string | null;
    scheduledEnd: string | null;
    anytime: boolean;
    notes: string;
    photos: Pick<PhotoRef, "id" | "label" | "takenAt" | "note" | "byWorkerId">[];
    checklist: Pick<ChecklistItem, "id" | "text" | "required" | "done" | "source">[];
    requireChecklist: boolean;
    requireSignature: boolean;
    signoff: { status: "none" | "pending" | "signed"; name: string };
  };
  job: {
    id: string;
    number: string;
    title: string;
    status: Job["status"];
    timezone: string;
    currency: string;
    address: string;
    invoiceIds: string[];
    timersEnabled: boolean;
    /** How the project is billed, for its colour; null while timesheets are off. */
    kind: "time_and_materials" | "day_rate" | "lump_sum" | null;
    description: string;
    notes: ReturnType<typeof notesForWorker>;
    /** What is being charged, only for staff who see prices; null for everyone else. */
    pricing: {
      kind: "time_and_materials" | "day_rate" | "lump_sum";
      lines: { id: string; description: string; qty: number; unitPriceMinor: number; extra: boolean }[];
      /** Time and materials projects: the office's own estimate, never billed as such. */
      estimate: { id: string; description: string; qty: number; unitPriceMinor: number }[];
      depositPaidMinor: number;
      /** Every priced part on the project, from all its visits, minus any waiting for the customer to approve. */
      parts: { id: string; name: string; qty: number; unitPriceMinor: number; here: boolean }[];
      /** Everything staff have recorded as collected on the project, from all its visits, not counting rejected ones. */
      collectedMinor: number;
      /** An invoice or estimate already exists, so what is still owed is on that invoice. */
      invoiced: boolean;
    } | null;
  };
  customer: { name: string; phone: string };
  perms: { prices: boolean; contact: boolean };
  timer: { id: string; startAt: string | null } | null;
  timeEntries: { id: string; startAt: string | null; endAt: string | null; running: boolean; flagged: boolean }[];
  materials: (Pick<MaterialLine, "id" | "name" | "qty" | "unit" | "notInEstimate"> & {
    unitPriceMinor: number;
    unitCostMinor: number;
  })[];
  payments: { id: string; method: string; amountMinor: number; status: string }[];
}

export interface TodayResult {
  workerId: string | null;
  visits: TodayVisit[];
}

const DAY = 86_400_000;

export async function todayForUser(input: {
  subAccountId: string;
  uid: string;
  now?: Date;
}): Promise<TodayResult> {
  const workerId = await workerForUid(input.subAccountId, input.uid);
  if (!workerId) return { workerId: null, visits: [] };
  const res = await todayForWorker({ subAccountId: input.subAccountId, workerId, now: input.now });
  // A staff member sees what their own price and contact switches allow, even when they are also an admin.
  const { projectVisit } = await import("@/lib/server/field-portal-access");
  const w = (await getAdminDb().doc(`fieldWorkers/${workerId}`).get()).data() ?? {};
  const link = {
    workerId,
    subAccountId: input.subAccountId,
    agencyId: (w.agencyId as string) ?? "",
    businessName: "",
    name: (w.name as string) ?? "",
    canHandlePrices: w.canHandlePrices === true,
    canSeeCustomerContact: w.canSeeCustomerContact !== false,
  };
  return { ...res, visits: res.visits.map((v) => projectVisit(v, link)) };
}

export async function todayForWorker(input: {
  subAccountId: string;
  workerId: string;
  now?: Date;
}): Promise<TodayResult> {
  const db = getAdminDb();
  const workerId = input.workerId;

  const now = input.now ?? new Date();
  const from = Timestamp.fromMillis(now.getTime() - 2 * DAY);
  const to = Timestamp.fromMillis(now.getTime() + 14 * DAY);
  const [subSnap, visitSnap, config] = await Promise.all([
    db.doc(`subAccounts/${input.subAccountId}`).get(),
    db
      .collection("visits")
      .where("subAccountId", "==", input.subAccountId)
      .where("workerIds", "array-contains", workerId)
      .where("scheduledStart", ">=", from)
      .where("scheduledStart", "<=", to)
      .orderBy("scheduledStart", "asc")
      .limit(100)
      .get(),
    getFieldServicesConfig(input.subAccountId).catch(() => null),
  ]);
  const terms = jobTerms(config);
  const subName = (subSnap.data()?.name as string | undefined) ?? "";

  const visits: TodayVisit[] = [];
  for (const doc of visitSnap.docs) {
    const v = { id: doc.id, ...doc.data() } as Visit;
    if (v.status === "cancelled") continue;
    const [jobSnap, contactSnap, timeSnap, matSnap, paySnap, jobMatSnap, jobPaySnap] = await Promise.all([
      db.doc(`jobs/${v.jobId}`).get(),
      db.doc(`contacts/${v.contactId}`).get(),
      db.collection("timeEntries").where("visitId", "==", v.id).where("workerId", "==", workerId).get(),
      db.collection("materialLines").where("visitId", "==", v.id).get(),
      db.collection("jobPayments").where("visitId", "==", v.id).get(),
      db.collection("materialLines").where("subAccountId", "==", input.subAccountId).where("jobId", "==", v.jobId).get(),
      db.collection("jobPayments").where("subAccountId", "==", input.subAccountId).where("jobId", "==", v.jobId).get(),
    ]);
    const job = jobSnap.data() as Job | undefined;
    if (!job || job.status === "closed") continue;
    const entries = timeSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }) as TimeEntry)
      .filter((e) => e.voided !== true);
    const running = entries.find((e) => e.running);
    visits.push({
      subAccountId: input.subAccountId,
      subAccountName: subName,
      jobWord: terms.Job,
      jobWordPlural: terms.Jobs,
      clock24: config?.use24HourTime === true,
      visit: {
        id: v.id,
        status: v.status,
        scheduledStart: tsToIso(v.scheduledStart),
        scheduledEnd: tsToIso(v.scheduledEnd),
        anytime: v.anytime,
        notes: v.notes ?? "",
        checklist: (v.checklist ?? []).map((i) => ({
          id: i.id,
          text: i.text,
          required: i.required === true,
          done: i.done === true,
          source: i.source,
        })),
        requireChecklist: v.requireChecklist === true,
        requireSignature: v.requireSignature === true,
        signoff: { status: v.signoff?.status ?? "none", name: v.signoff?.name ?? "" },
        photos: (v.photos ?? []).map((p) => ({
          id: p.id,
          label: p.label,
          takenAt: p.takenAt,
          note: p.note ?? null,
          byWorkerId: p.byWorkerId,
        })),
      },
      job: {
        id: job.id ?? v.jobId,
        number: job.number,
        title: job.title,
        status: job.status,
        timezone: job.timezone,
        currency: job.currency,
        address: formatServiceAddress(job.serviceAddress),
        invoiceIds: job.invoiceIds ?? [],
        timersEnabled: job.timersEnabled === true,
        kind: config?.timesheetsEnabled ? effectiveBillingType(job) : null,
        description: job.description ?? "",
        notes: notesForWorker(job.notes, workerId),
        pricing: {
          kind: config?.timesheetsEnabled ? effectiveBillingType(job) : "lump_sum",
          lines: (job.lineItems ?? []).map((l) => ({
            id: l.id,
            description: l.description,
            qty: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            extra: !!l.approvalId,
          })),
          estimate: (job.estimateLines ?? []).map((l) => ({
            id: l.id,
            description: l.description,
            qty: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
          })),
          depositPaidMinor: job.depositPaidMinor ?? 0,
          parts: jobMatSnap.docs
            .map((d) => ({ ...(d.data() as MaterialLine), id: d.id }))
            .filter((m) => m.approval !== "pending" && m.approval !== "declined")
            .map((m) => ({ id: m.id, name: m.name, qty: m.qty, unitPriceMinor: m.unitPriceMinor, here: m.visitId === v.id })),
          collectedMinor: jobPaySnap.docs
            .map((d) => d.data() as JobPayment)
            .filter((p) => p.status !== "rejected")
            .reduce((n, p) => n + p.amountMinor, 0),
          invoiced: (job.invoiceIds?.length ?? 0) > 0 || !!job.quoteId || !!job.travelFeeInvoiceId,
        },
      },
      customer: {
        name: (contactSnap.data()?.name as string | undefined) ?? job.contactName ?? "",
        phone: (contactSnap.data()?.phone as string | undefined) ?? "",
      },
      perms: { prices: true, contact: true },
      timer: running ? { id: running.id, startAt: tsToIso(running.startAt) } : null,
      timeEntries: entries.map((e) => ({
        id: e.id,
        startAt: tsToIso(e.startAt),
        endAt: tsToIso(e.endAt),
        running: e.running,
        flagged: !!e.correctionRequest,
      })),
      materials: matSnap.docs.map((d) => {
        const m = d.data() as MaterialLine;
        return {
          id: d.id,
          name: m.name,
          qty: m.qty,
          unit: m.unit,
          notInEstimate: m.notInEstimate,
          unitPriceMinor: m.unitPriceMinor,
          unitCostMinor: m.unitCostMinor,
        };
      }) as TodayVisit["materials"],
      payments: paySnap.docs.map((d) => {
        const p = d.data() as JobPayment;
        return { id: d.id, method: p.method, amountMinor: p.amountMinor, status: p.status };
      }),
    });
  }
  return { workerId, visits };
}
