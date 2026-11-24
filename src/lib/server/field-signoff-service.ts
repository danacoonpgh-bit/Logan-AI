import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { jobStatusUrl, readJobStatusToken } from "@/lib/field-services/job-status-token";
import { sendPushForEvent } from "@/lib/push/send";
import { deliverToContact } from "@/lib/server/field-messages-service";
import { requiredLeft } from "@/lib/server/field-checklists-service";
import { hitLimit } from "@/lib/server/field-rate-limit";
import { recordFieldActivity } from "@/lib/server/field-events";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getJobTerms } from "@/lib/server/field-services-config-service";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";
import type { Job, Visit } from "@/types/field-services";

function plain(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "";
}

function firstName(name: string): string {
  const t = (name ?? "").trim();
  return t ? t.split(/\s+/)[0] : "there";
}

/** Asks the customer to confirm the work from their status link. A worker or the office can ask. */
export async function requestSignoff(input: {
  subAccountId: string;
  visitId: string;
  actor: { isOffice: boolean; workerId: string | null; uid: string };
}): Promise<{ id: string; delivered: "sms" | "email" | null }> {
  const db = getAdminDb();
  const terms = await getJobTerms(input.subAccountId);
  const visitRef = db.doc(`visits/${input.visitId}`);
  const visit = (await visitRef.get()).data() as Visit | undefined;
  if (!visit || visit.subAccountId !== input.subAccountId) throw new FieldServicesError("Visit not found.", 404);
  if (!input.actor.isOffice) {
    if (!input.actor.workerId || !visit.workerIds.includes(input.actor.workerId)) {
      throw new FieldServicesError("You can only update visits you are assigned to.", 403);
    }
  }
  if (visit.status !== "checked_in" && visit.status !== "completed") {
    throw new FieldServicesError("Mark that you have arrived before asking the customer to sign off.", 409);
  }
  if (visit.signoff?.status === "signed") throw new FieldServicesError("The customer already signed off.", 409);
  if (visit.requireChecklist && requiredLeft(visit) > 0) {
    throw new FieldServicesError("Finish the checklist first.", 409);
  }
  const jobSnap = await db.doc(`jobs/${visit.jobId}`).get();
  const job = jobSnap.data() as Job | undefined;
  if (!job || job.subAccountId !== input.subAccountId) throw new FieldServicesError(`${terms.Job} not found.`, 404);
  if (job.status === "closed" || job.status === "cancelled") {
    throw new FieldServicesError(`This ${terms.job} is closed.`, 409);
  }
  const url = jobStatusUrl(visit.jobId, job.statusTokenVersion ?? 1);
  if (!url) {
    throw new FieldServicesError(
      "Customer links need AUTOMATIONS_TOKEN_SECRET and an https NEXT_PUBLIC_APP_URL to be set first.",
      503,
    );
  }
  const sends = await hitLimit(`so:send:${input.visitId}`, 6, 24 * 3_600_000);
  if (!sends.ok) throw new FieldServicesError("That's plenty of requests for one visit today.", 429);

  const ref = db.collection("visitSignoffs").doc();
  await db.runTransaction(async (tx) => {
    const [liveSnap, older] = await Promise.all([
      tx.get(visitRef),
      tx.get(
        db.collection("visitSignoffs").where("visitId", "==", input.visitId).where("status", "==", "pending"),
      ),
    ]);
    if ((liveSnap.data() as Visit | undefined)?.signoff?.status === "signed") {
      throw new FieldServicesError("The customer already signed off.", 409);
    }
    for (const d of older.docs) {
      tx.update(d.ref, { status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
    }
    tx.set(ref, {
      agencyId: visit.agencyId,
      subAccountId: visit.subAccountId,
      jobId: visit.jobId,
      visitId: input.visitId,
      contactId: visit.contactId,
      status: "pending",
      requestedByUid: input.actor.uid,
      response: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(visitRef, {
      signoff: { id: ref.id, status: "pending", requestedAt: Date.now() },
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  let delivered: "sms" | "email" | null = null;
  try {
    const [subSnap, contactSnap] = await Promise.all([
      db.doc(`subAccounts/${job.subAccountId}`).get(),
      db.doc(`contacts/${job.contactId}`).get(),
    ]);
    const sub = subSnap.data() as SubAccountDoc | undefined;
    if (sub && contactSnap.exists) {
      const contact = { id: contactSnap.id, ...contactSnap.data() } as Contact;
      const body = `Hi ${firstName(contact.name)}, ${sub.name || "we"} have finished work on "${job.title}". Please confirm it is complete here: ${url} (Anyone with this link can answer, so please don't forward it.)`;
      delivered = await deliverToContact({
        sub,
        contact,
        body,
        subject: `${sub.name || `Your ${terms.job}`}: please confirm the work`,
        agencyId: job.agencyId,
        subAccountId: job.subAccountId,
        label: "Sign-off request",
        meta: { jobId: visit.jobId, visitId: input.visitId, signoffId: ref.id },
      });
    }
  } catch (err) {
    console.warn("[field-signoff] message failed", err);
  }
  await recordFieldActivity(job.contactId, "field_visit", `Sign-off requested on ${terms.job} ${job.number}.`, {
    jobId: visit.jobId,
    visitId: input.visitId,
  });
  return { id: ref.id, delivered };
}

export type SignoffResult = "ok" | "invalid" | "limited" | "answered" | "expired" | "notready";

/** The customer's confirmation from their status page: a typed name, kept with when, where from and what was ticked. */
export async function respondToSignoff(input: {
  token: unknown;
  signoffId: unknown;
  name: unknown;
  comment: unknown;
  ip: string;
  userAgent?: string;
}): Promise<SignoffResult> {
  const byIp = await hitLimit(`so:ip:${input.ip}`, 40, 3_600_000);
  if (!byIp.ok) return "limited";
  const parsed = readJobStatusToken(input.token);
  if (!parsed || typeof input.signoffId !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(input.signoffId)) {
    return "invalid";
  }
  const byJob = await hitLimit(`so:job:${parsed.jobId}`, 30, 3_600_000);
  if (!byJob.ok) return "limited";
  const name = plain(input.name, 120);
  const comment = plain(input.comment, 500);
  if (name.length < 2) return "invalid";

  const db = getAdminDb();
  const jobRef = db.doc(`jobs/${parsed.jobId}`);
  const signoffRef = db.doc(`visitSignoffs/${input.signoffId}`);

  const outcome = await db.runTransaction(async (tx) => {
    const [jobSnap, sSnap] = await Promise.all([tx.get(jobRef), tx.get(signoffRef)]);
    const job = jobSnap.data() as Job | undefined;
    const s = sSnap.data();
    if (!job || !s || s.jobId !== parsed.jobId || s.subAccountId !== job.subAccountId) return "invalid" as const;
    const [subSnap, visitSnap] = await Promise.all([
      tx.get(db.doc(`subAccounts/${job.subAccountId}`)),
      tx.get(db.doc(`visits/${s.visitId}`)),
    ]);
    if (!fieldServicesAvailable(subSnap.data())) return "invalid" as const;
    if ((job.statusTokenVersion ?? 1) !== parsed.version) return "invalid" as const;
    if (job.status === "closed" || job.status === "cancelled") return "invalid" as const;
    const visit = visitSnap.data() as Visit | undefined;
    if (!visit || visit.jobId !== parsed.jobId || visit.status === "cancelled") return "invalid" as const;
    if (s.status === "signed") return "answered" as const;
    if (s.status !== "pending" || visit.signoff?.id !== sSnap.id) return "expired" as const;
    if (visit.status !== "checked_in" && visit.status !== "completed") return "expired" as const;
    // Items unticked after the request would lock the list with the work still open.
    if (visit.requireChecklist && requiredLeft(visit) > 0) return "notready" as const;

    const signedAt = Date.now();
    const checklist = (visit.checklist ?? []).map((i) => ({
      text: i.text,
      required: i.required,
      done: i.done,
      source: i.source,
    }));
    const contentHash = createHash("sha256")
      .update(
        JSON.stringify({
          signoffId: sSnap.id,
          jobId: parsed.jobId,
          visitId: visitSnap.id,
          job: job.number,
          checklist,
          name,
          comment,
          signedAt,
        }),
      )
      .digest("hex");
    tx.update(signoffRef, {
      status: "signed",
      respondedAt: FieldValue.serverTimestamp(),
      checklist,
      contentHash,
      response: {
        name,
        comment,
        ipHash: createHash("sha256").update(input.ip).digest("hex").slice(0, 32),
        userAgent: (input.userAgent ?? "").slice(0, 200),
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(visitSnap.ref, {
      signoff: { id: sSnap.id, status: "signed", requestedAt: visit.signoff?.requestedAt ?? signedAt, signedAt, name },
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { job: { ...job, id: jobSnap.id }, visitId: visitSnap.id, signoffId: sSnap.id };
  });
  if (typeof outcome === "string") return outcome;

  const { job, visitId, signoffId } = outcome;
  const terms = await getJobTerms(job.subAccountId);
  const text = `"${name}" confirmed the work on ${terms.job} ${job.number}.${comment ? ` They said: "${comment}"` : ""}`;
  await recordFieldActivity(job.contactId, "field_visit", text, { jobId: job.id, visitId, signoffId });
  await sendPushForEvent({
    subAccountId: job.subAccountId,
    agencyId: job.agencyId,
    title: "Customer signed off",
    body: text,
    territoryId: job.territoryId,
    url: `/sa/${job.subAccountId}/field-services`,
    tag: `signoff-${signoffId}`,
  }).catch(() => {});
  return "ok";
}

/** Called when a job closes or is cancelled, so the customer is not left with a button that fails. */
export async function cancelPendingSignoffs(jobId: string): Promise<void> {
  const db = getAdminDb();
  const snap = await db
    .collection("visitSignoffs")
    .where("jobId", "==", jobId)
    .where("status", "==", "pending")
    .get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const d of snap.docs) {
    batch.update(d.ref, { status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
}

/** A visit that was cancelled or marked a no-show can no longer be signed off. */
export async function cancelPendingSignoffsForVisit(visitId: string): Promise<void> {
  const db = getAdminDb();
  const snap = await db
    .collection("visitSignoffs")
    .where("visitId", "==", visitId)
    .where("status", "==", "pending")
    .get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const d of snap.docs) {
    batch.update(d.ref, { status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
}
