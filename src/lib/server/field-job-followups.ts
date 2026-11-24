import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { updateDealServerSide } from "@/lib/server/deals-service";
import { dealPipelineId, getPipeline, wonStageId } from "@/lib/pipelines/resolve";
import { loadResolvedPipelines } from "@/lib/server/pipelines-service";
import type { Job } from "@/types/field-services";
import type { Quote } from "@/types/quotes";

async function gateOn(subAccountId: string): Promise<boolean> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return fieldServicesAvailable(snap.data());
}

async function invoicesAllPaid(job: Job): Promise<boolean> {
  if (job.invoiceIds.length === 0) return true;
  const db = getAdminDb();
  const snaps = await Promise.all(job.invoiceIds.map((id) => db.doc(`quotes/${id}`).get()));
  return snaps.every((s) => !s.exists || (s.data() as Quote | undefined)?.status === "paid");
}

async function claimReview(jobId: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`jobs/${jobId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.reviewClaimedAt) return false;
    tx.update(ref, { reviewClaimedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

async function sendReview(job: Job): Promise<void> {
  if (!(await claimReview(job.id))) return;
  const res = await maybeSendReviewRequest({
    subAccountId: job.subAccountId,
    agencyId: job.agencyId,
    contactId: job.contactId,
    trigger: "job_completed",
  });
  if (!res.sent) {
    await getAdminDb()
      .doc(`jobs/${job.id}`)
      .update({ reviewClaimedAt: FieldValue.delete() })
      .catch(() => {});
  }
}

/** A deal whose project gets its first visit is won: the customer has agreed and the work is booked. */
export async function moveDealToWonWhenScheduled(job: Job): Promise<void> {
  try {
    if (!job.dealId || !(await gateOn(job.subAccountId))) return;
    const deal = (await getAdminDb().doc(`deals/${job.dealId}`).get()).data();
    if (!deal || deal.subAccountId !== job.subAccountId) return;
    const pipeline = getPipeline(await loadResolvedPipelines(job.subAccountId), dealPipelineId(deal));
    const stage = pipeline.stages.find((st) => st.id === deal.stageId);
    // Won and lost deals stay where they are.
    if (stage?.terminal) return;
    await updateDealServerSide({
      dealId: job.dealId,
      patch: { stageId: wonStageId(pipeline) },
      userId: "field-services",
      expectedSubAccountId: job.subAccountId,
    });
  } catch (err) {
    console.warn("[field-followups] deal move to won failed", err);
  }
}

export async function runJobCompletedFollowups(job: Job): Promise<void> {
  try {
    if (!(await gateOn(job.subAccountId))) return;
    const deal = job.dealId ? (await getAdminDb().doc(`deals/${job.dealId}`).get()).data() : null;
    // A deal still being worked, such as one from the booking page, is not ticked as delivered.
    const won =
      !!deal &&
      deal.subAccountId === job.subAccountId &&
      deal.stageId === wonStageId(getPipeline(await loadResolvedPipelines(job.subAccountId), dealPipelineId(deal)));
    if (job.dealId && won) {
      await updateDealServerSide({
        dealId: job.dealId,
        patch: { completed: true },
        userId: "field-services",
        expectedSubAccountId: job.subAccountId,
      }).catch((err) => console.warn("[field-followups] deal tick failed", err));
    }
    if (!(await gateOn(job.subAccountId))) return;
    const config = await getFieldServicesConfig(job.subAccountId);
    if (!config.reviewRequestsEnabled) return;
    // Waiting for payment also means waiting for an invoice (or a confirmed cash payment).
    if (config.reviewWaitsForPayment && (job.invoiceIds.length === 0 || !(await invoicesAllPaid(job)))) {
      return;
    }
    await sendReview(job);
  } catch (err) {
    console.warn("[field-followups] job completed follow-ups failed", err);
  }
}

export async function onInvoicePaidForJob(jobId: string, subAccountId: string): Promise<void> {
  try {
    const snap = await getAdminDb().doc(`jobs/${jobId}`).get();
    const job = snap.exists ? ({ id: snap.id, ...snap.data() } as Job) : null;
    if (!job || job.subAccountId !== subAccountId || !job.completedFiredAt) return;
    if (!(await gateOn(subAccountId))) return;
    const config = await getFieldServicesConfig(subAccountId);
    if (!config.reviewRequestsEnabled || !config.reviewWaitsForPayment) return;
    if (!(await invoicesAllPaid(job))) return;
    await sendReview(job);
  } catch (err) {
    console.warn("[field-followups] invoice paid follow-up failed", err);
  }
}
