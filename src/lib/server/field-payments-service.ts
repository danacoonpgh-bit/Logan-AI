import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { minorToUnit, unitToMinor } from "@/lib/field-services/money";
import {
  assertCanActOnVisit,
  type FieldActor,
} from "@/lib/server/field-access";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getJobTerms } from "@/lib/server/field-services-config-service";
import {
  emitFieldWebhook,
  recordFieldActivity,
} from "@/lib/server/field-events";
import { markQuotePaidServerSide } from "@/lib/server/quotes-service";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import type { Job, JobPayment, JobPaymentMethod, Visit } from "@/types/field-services";
import type { Quote } from "@/types/quotes";

const METHODS: JobPaymentMethod[] = ["cash", "cheque", "terminal", "other"];

export async function recordOnSitePayment(input: {
  subAccountId: string;
  visitId: string;
  actor: FieldActor;
  body: Record<string, unknown>;
}): Promise<{ id: string }> {
  const db = getAdminDb();
  const vSnap = await db.doc(`visits/${input.visitId}`).get();
  if (!vSnap.exists || vSnap.data()?.subAccountId !== input.subAccountId) {
    throw new FieldServicesError("Visit not found.", 404);
  }
  const visit = { id: vSnap.id, ...vSnap.data() } as Visit;
  assertCanActOnVisit(input.actor, visit);
  const job = (await db.doc(`jobs/${visit.jobId}`).get()).data() as Job | undefined;
  const terms = await getJobTerms(input.subAccountId);
  if (!job) throw new FieldServicesError(`${terms.Job} not found.`, 404);
  if (job.status === "cancelled") throw new FieldServicesError(`This ${terms.job} was cancelled.`, 409);

  const b = input.body;
  const method = METHODS.includes(b.method as JobPaymentMethod)
    ? (b.method as JobPaymentMethod)
    : null;
  if (!method) throw new FieldServicesError("Choose how it was paid.");
  const amount = Number(b.amountMinor);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw new FieldServicesError("Enter the amount collected.");
  }
  let invoiceId: string | null = null;
  if (typeof b.invoiceId === "string" && b.invoiceId) {
    if (!job.invoiceIds.includes(b.invoiceId)) {
      throw new FieldServicesError(`That invoice isn't on this ${terms.job}.`);
    }
    invoiceId = b.invoiceId;
  }

  const ref = db.collection("jobPayments").doc();
  const doc: Omit<JobPayment, "id"> = {
    agencyId: visit.agencyId,
    subAccountId: visit.subAccountId,
    territoryId: visit.territoryId,
    jobId: visit.jobId,
    visitId: visit.id,
    workerId: input.actor.workerId ?? visit.workerIds[0] ?? "",
    invoiceId,
    method,
    amountMinor: Math.round(amount),
    currency: job.currency,
    note: typeof b.note === "string" ? b.note.trim().slice(0, 500) : "",
    photo: null,
    status: "pending",
    confirmedBy: null,
    confirmedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);

  await recordFieldActivity(
    job.contactId,
    "field_job",
    `Payment of ${minorToUnit(job.currency, doc.amountMinor).toFixed(2)} ${job.currency} (${method}) recorded on site for ${job.number}, waiting for confirmation.`,
    { jobId: job.id, paymentId: ref.id },
  );
  emitFieldWebhook({
    subAccountId: visit.subAccountId,
    agencyId: visit.agencyId,
    type: "payment.recorded_on_site",
    payload: {
      payment: {
        id: ref.id,
        object: "job_payment",
        job_id: job.id,
        visit_id: visit.id,
        invoice_id: invoiceId,
        method,
        amount: doc.amountMinor,
        currency: job.currency,
        status: "pending",
      },
    },
  });
  await createTaskServerSide({
    subAccountId: visit.subAccountId,
    agencyId: visit.agencyId,
    createdByUid: input.actor.uid,
    mode: "live",
    title: `Confirm on-site payment: ${job.number} ${job.title}`.trim(),
    notes: `${method} payment of ${minorToUnit(job.currency, doc.amountMinor).toFixed(2)} ${job.currency} recorded at the ${terms.job}. Confirm it when the money is in.`,
    dueAt: null,
    contactId: job.contactId,
    dealId: null,
    eventId: null,
  }).catch((err) => console.warn("[field-payments] task failed", err));
  return { id: ref.id };
}

export async function decidePayment(input: {
  subAccountId: string;
  paymentId: string;
  actorUid: string;
  decision: "confirm" | "reject";
}): Promise<{ invoicePaid: boolean }> {
  const db = getAdminDb();
  const ref = db.doc(`jobPayments/${input.paymentId}`);

  // Claim the decision first so concurrent decisions cannot disagree.
  const payment = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const p = snap.data() as (JobPayment & { decidingAt?: number }) | undefined;
    if (!snap.exists || !p || p.subAccountId !== input.subAccountId) {
      throw new FieldServicesError("Payment not found.", 404);
    }
    if (p.status !== "pending" || (p.decidingAt && Date.now() - p.decidingAt < 120_000)) {
      throw new FieldServicesError("This payment was already decided.", 409);
    }
    tx.update(ref, { decidingAt: Date.now() });
    return { ...p, id: snap.id } as JobPayment;
  });

  const release = () => ref.update({ decidingAt: FieldValue.delete() }).catch(() => {});
  let invoicePaid = false;
  try {
    if (input.decision === "confirm" && payment.invoiceId) {
      const qSnap = await db.doc(`quotes/${payment.invoiceId}`).get();
      const quote = qSnap.data() as Quote | undefined;
      if (!quote || quote.subAccountId !== input.subAccountId) {
        throw new FieldServicesError("The linked invoice no longer exists.", 409);
      }
      if (quote.currency !== payment.currency) {
        throw new FieldServicesError(
          "The invoice currency changed since this payment was recorded. Reject the claim and record it again.",
          409,
        );
      }
      const total = unitToMinor(quote.currency, computeQuoteTotals(quote).total);
      if (total !== payment.amountMinor) {
        throw new FieldServicesError(
          "The amount differs from the invoice total, so it can't mark the invoice paid. Reject this claim, or fix the invoice first.",
          409,
        );
      }
      const res = await markQuotePaidServerSide({
        quoteId: payment.invoiceId,
        expectSubAccountId: input.subAccountId,
      });
      if (!res.ok) {
        throw new FieldServicesError(
          res.code === "already_paid"
            ? "That invoice is already paid, so this cash would be counted twice. Reject the claim instead."
            : res.code === "bad_status"
              ? "Send the invoice first, then confirm the payment."
              : res.message,
          409,
        );
      }
      invoicePaid = true;
    }
    const decided = {
      status: input.decision === "confirm" ? "confirmed" : "rejected",
      confirmedBy: input.actorUid,
      confirmedAt: FieldValue.serverTimestamp(),
      decidingAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    // The invoice is already paid by now, so the record must not stay pending.
    for (let attempt = 1; ; attempt++) {
      try {
        await ref.update(decided);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
    // Cash with no invoice behind it counts as paid for a review that waits on payment.
    if (input.decision === "confirm" && !payment.invoiceId) {
      const { onInvoicePaidForJob } = await import("@/lib/server/field-job-followups");
      await onInvoicePaidForJob(payment.jobId, input.subAccountId);
    }
  } catch (err) {
    await release();
    throw err;
  }
  return { invoicePaid };
}
