import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { jobStatusUrl } from "@/lib/field-services/job-status-token";
import { formatServiceAddress } from "@/lib/field-services/address";
import { getJobTerms } from "@/lib/server/field-services-config-service";
import { computeQuoteTotals, lineItemSubtotal } from "@/lib/quotes/calc";
import { invoiceCardBlock } from "@/lib/server/invoice-card-payment";
import type { Job, ServiceRequest, Visit } from "@/types/field-services";
import type { Quote } from "@/types/quotes";

const MAX_JOBS = 30;
const MAX_INVOICES = 50;
const DAY_MS = 86_400_000;

export interface PortalVisit {
  startAt: string | null;
  anytime: boolean;
  timezone: string;
  crew: string[];
}

export interface PortalJob {
  number: string;
  title: string;
  status: string;
  /** How the status pill is coloured. */
  tone: "info" | "warn" | "ok" | "muted";
  /** Finished or cancelled, so it moves to the past list. */
  past: boolean;
  address: string;
  nextVisit: PortalVisit | null;
  statusUrl: string | null;
}

export interface PortalRequest {
  number: string;
  title: string;
}

export interface PortalInvoiceLine {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface PortalInvoice {
  id: string;
  number: string;
  /** The project it was raised for, when there is one. */
  jobNumber: string | null;
  paid: boolean;
  /** "Due on receipt", "Due 14 Nov" or empty. */
  dueLabel: string;
  currency: string;
  lines: PortalInvoiceLine[];
  subtotal: number;
  discount: number;
  taxPercent: number | null;
  tax: number;
  total: number;
  notes: string;
  sentAt: string | null;
  paidAt: string | null;
  /** The card button works right now. */
  canPayByCard: boolean;
  /** A paypal.me address the business set up, if any. */
  payPalUrl: string | null;
}

export interface CustomerHome {
  name: string;
  jobWord: string;
  jobsWord: string;
  jobs: PortalJob[];
  requests: PortalRequest[];
  invoices: PortalInvoice[];
}

const STATUS_LABELS: Record<string, string> = {
  unscheduled: "Waiting to be scheduled",
  scheduled: "Scheduled",
  in_progress: "In progress",
  ready_to_invoice: "Work finished",
  action_required: "We'll be in touch",
  closed: "Completed",
  cancelled: "Cancelled",
};

const STATUS_TONES: Record<string, "info" | "warn" | "ok" | "muted"> = {
  unscheduled: "warn",
  scheduled: "info",
  in_progress: "info",
  ready_to_invoice: "ok",
  action_required: "warn",
  closed: "ok",
  cancelled: "muted",
};

function ms(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

/** What a signed-in customer sees: their own requests and projects, and when someone is next due. Scoped to the contact. */
export async function loadCustomerHome(subAccountId: string, contactId: string): Promise<CustomerHome | null> {
  const db = getAdminDb();
  const contactSnap = await db.doc(`contacts/${contactId}`).get();
  if (!contactSnap.exists || contactSnap.data()?.subAccountId !== subAccountId) return null;

  const [terms, jobSnap, requestSnap, visitSnap, quoteSnap, subSnap] = await Promise.all([
    getJobTerms(subAccountId),
    db.collection("jobs").where("subAccountId", "==", subAccountId).where("contactId", "==", contactId).get(),
    db.collection("serviceRequests").where("subAccountId", "==", subAccountId).where("contactId", "==", contactId).get(),
    db.collection("visits").where("subAccountId", "==", subAccountId).where("contactId", "==", contactId).get(),
    // Two equality filters only, so no composite index; the kind is filtered below.
    db.collection("quotes").where("subAccountId", "==", subAccountId).where("contactId", "==", contactId).get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);

  const now = Date.now();
  const visitsByJob = new Map<string, Visit[]>();
  for (const d of visitSnap.docs) {
    const v = { id: d.id, ...d.data() } as Visit;
    if (v.status === "cancelled" || v.status === "completed" || v.status === "no_show") continue;
    const start = ms(v.scheduledStart);
    const end = ms(v.scheduledEnd);
    // A visit that has started but not finished is still the next one.
    const underway = v.status === "on_my_way" || v.status === "checked_in" || (end !== null && end > now);
    if (start === null || (start < now - 4 * 3_600_000 && !underway)) continue;
    visitsByJob.set(v.jobId, [...(visitsByJob.get(v.jobId) ?? []), v]);
  }

  const jobs = jobSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Job)
    // Work still going comes first, so a long history can't push it off the list.
    .sort((a, b) => {
      const done = (j: Job) => (j.status === "closed" || j.status === "cancelled" ? 1 : 0);
      return done(a) - done(b) || (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0);
    })
    .slice(0, MAX_JOBS);

  const workerIds = new Set<string>();
  const next = new Map<string, Visit>();
  for (const job of jobs) {
    const first = (visitsByJob.get(job.id) ?? []).sort((a, b) => (ms(a.scheduledStart) ?? 0) - (ms(b.scheduledStart) ?? 0))[0];
    if (first) {
      next.set(job.id, first);
      for (const w of first.workerIds ?? []) workerIds.add(w);
    }
  }
  const names = new Map<string, string>();
  const ids = [...workerIds].slice(0, 60);
  if (ids.length) {
    for (const w of await db.getAll(...ids.map((id) => db.doc(`fieldWorkers/${id}`)))) {
      if (w.exists && w.data()?.subAccountId === subAccountId) {
        names.set(w.id, String(w.data()?.name ?? "").split(/\s+/)[0]);
      }
    }
  }

  const paymentsOn = subSnap.data()?.paymentsEnabledByAgency === true;
  const jobNumbers = new Map(jobSnap.docs.map((d) => [d.id, String(d.data().number ?? "")]));
  const invoices = quoteSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Quote)
    // Only invoices that have gone out; a draft is still being worked on.
    .filter((q) => q.kind === "invoice" && Array.isArray(q.lineItems) && (q.status === "sent" || q.status === "viewed" || q.status === "paid"))
    .sort((a, b) => (ms(b.sentAt) ?? ms(b.createdAt) ?? 0) - (ms(a.sentAt) ?? ms(a.createdAt) ?? 0))
    .slice(0, MAX_INVOICES)
    .map((q): PortalInvoice => {
      const totals = computeQuoteTotals(q);
      const sent = ms(q.sentAt);
      const paid = q.status === "paid";
      let dueLabel = "";
      if (!paid && typeof q.paymentDueDays === "number") {
        if (q.paymentDueDays <= 0) dueLabel = "Due on receipt";
        else if (sent !== null) {
          dueLabel = `Due ${new Date(sent + q.paymentDueDays * DAY_MS).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" })}`;
        }
      }
      const link = typeof q.paymentLinkUrl === "string" ? q.paymentLinkUrl : "";
      return {
        id: q.id,
        number: q.quoteNumber,
        jobNumber: q.jobId ? jobNumbers.get(q.jobId) || null : null,
        paid,
        dueLabel,
        currency: q.currency || "USD",
        lines: q.lineItems.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          total: lineItemSubtotal(l),
        })),
        subtotal: totals.subtotal,
        discount: totals.discountAmount,
        taxPercent: q.globalTaxPercent ?? null,
        tax: totals.taxAmount,
        total: totals.total,
        notes: q.termsAndNotes ?? "",
        sentAt: sent === null ? null : new Date(sent).toISOString(),
        paidAt: ms(q.paidAt) === null ? null : new Date(ms(q.paidAt) as number).toISOString(),
        canPayByCard: invoiceCardBlock(q, paymentsOn) === null,
        payPalUrl: !paid && /^https:\/\/(www\.)?paypal\.me\//i.test(link) ? link : null,
      };
    });

  return {
    name: String(contactSnap.data()?.name ?? ""),
    jobWord: terms.job,
    jobsWord: terms.jobs,
    jobs: jobs.map((job) => {
      const v = next.get(job.id);
      const start = v ? ms(v.scheduledStart) : null;
      return {
        number: job.number,
        title: job.title,
        status: STATUS_LABELS[job.status] ?? "In progress",
        tone: STATUS_TONES[job.status] ?? "info",
        past: job.status === "closed" || job.status === "cancelled",
        address: job.serviceAddress ? formatServiceAddress(job.serviceAddress) : "",
        nextVisit: v
          ? {
              startAt: start === null ? null : new Date(start).toISOString(),
              anytime: v.anytime === true,
              timezone: job.timezone,
              crew: (v.workerIds ?? []).map((w) => names.get(w) ?? "").filter(Boolean),
            }
          : null,
        statusUrl: jobStatusUrl(job.id, job.statusTokenVersion ?? 1),
      };
    }),
    invoices,
    requests: requestSnap.docs
      .map((d) => d.data() as ServiceRequest)
      .filter((r) => (r.status === "new" || r.status === "action_required") && !r.convertedTo)
      .map((r) => ({ number: r.number, title: r.title })),
  };
}
