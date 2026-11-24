import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatMoneyCode } from "@/lib/field-services/money";
import { createHash } from "node:crypto";
import { jobStatusUrl, readJobStatusToken } from "@/lib/field-services/job-status-token";
import { sendPushForEvent } from "@/lib/push/send";
import { deliverToContact } from "@/lib/server/field-messages-service";
import { hitLimit } from "@/lib/server/field-rate-limit";
import { recordFieldActivity } from "@/lib/server/field-events";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getJobTerms } from "@/lib/server/field-services-config-service";
import { withArticleCap } from "@/lib/field-services/terms";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types/tenancy";
import type { ExtraWorkApproval, Job, JobLineItem } from "@/types/field-services";

const MAX_LINES = 10;
const MAX_PENDING = 5;
const MAX_JOB_LINES = 50;
const MAX_STORED_LINES = 100;

function cleanLines(input: unknown): JobLineItem[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new FieldServicesError("Add at least one line.");
  }
  if (input.length > MAX_LINES) throw new FieldServicesError(`No more than ${MAX_LINES} lines at once.`);
  return input.map((raw, i) => {
    const l = raw as { description?: unknown; quantity?: unknown; unitPriceMinor?: unknown };
    const description = typeof l.description === "string" ? l.description.trim().slice(0, 200) : "";
    const quantity = typeof l.quantity === "number" ? Math.round(l.quantity * 100) / 100 : NaN;
    const price = typeof l.unitPriceMinor === "number" ? Math.round(l.unitPriceMinor) : NaN;
    if (!description) throw new FieldServicesError(`Line ${i + 1} needs a description.`);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000) {
      throw new FieldServicesError(`Line ${i + 1} needs a quantity between 0 and 1,000.`);
    }
    if (!Number.isFinite(price) || price < 0 || price > 100_000_000) {
      throw new FieldServicesError(`Line ${i + 1} needs a valid price.`);
    }
    return { id: crypto.randomUUID(), description, quantity, unitPriceMinor: price };
  });
}

function openLineCount(job: Job): number {
  return job.lineItems.filter((l) => !(l.approvalId && job.billedApprovals?.[l.approvalId])).length;
}

function plain(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "";
}

function totalOf(lines: JobLineItem[]): number {
  return lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unitPriceMinor), 0);
}

function firstName(name: string): string {
  const t = (name ?? "").trim();
  return t ? t.split(/\s+/)[0] : "there";
}

export async function createApproval(input: {
  subAccountId: string;
  jobId: string;
  createdByUid: string;
  lines: unknown;
  note: unknown;
}): Promise<{ id: string; delivered: "sms" | "email" | null; url: string | null }> {
  const db = getAdminDb();
  const terms = await getJobTerms(input.subAccountId);
  const jobSnap = await db.doc(`jobs/${input.jobId}`).get();
  const job = jobSnap.data() as Job | undefined;
  if (!job || job.subAccountId !== input.subAccountId) throw new FieldServicesError(`${terms.Job} not found.`, 404);
  if (job.status === "closed" || job.status === "cancelled") {
    throw new FieldServicesError(`A closed or cancelled ${terms.job} can't take extra work.`, 409);
  }
  const url = jobStatusUrl(input.jobId, job.statusTokenVersion ?? 1);
  if (!url) {
    throw new FieldServicesError(
      "Customer links need AUTOMATIONS_TOKEN_SECRET and an https NEXT_PUBLIC_APP_URL to be set first.",
      503,
    );
  }
  const lines = cleanLines(input.lines);
  if (openLineCount(job) + lines.length > MAX_JOB_LINES) {
    throw new FieldServicesError(`${withArticleCap(terms.job)} can hold ${MAX_JOB_LINES} lines. Remove some first.`, 409);
  }
  const sends = await hitLimit(`ew:send:${input.jobId}`, 10, 24 * 3_600_000);
  if (!sends.ok) throw new FieldServicesError(`That's plenty of requests for one ${terms.job} today. Try tomorrow.`, 429);
  const total = totalOf(lines);
  if (total <= 0) throw new FieldServicesError("The total must be more than zero.");

  const pending = await db
    .collection("jobApprovals")
    .where("jobId", "==", input.jobId)
    .where("status", "==", "pending")
    .get();
  if (pending.size >= MAX_PENDING) {
    throw new FieldServicesError(`This ${terms.job} already has several requests waiting. Cancel one first.`, 409);
  }

  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
  const ref = db.collection("jobApprovals").doc();
  const doc: Omit<ExtraWorkApproval, "id"> = {
    agencyId: job.agencyId,
    subAccountId: job.subAccountId,
    jobId: job.id ?? input.jobId,
    contactId: job.contactId,
    lines,
    currency: job.currency,
    totalMinor: total,
    note,
    status: "pending",
    createdByUid: input.createdByUid,
    response: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);

  let delivered: "sms" | "email" | null = null;
  try {
    const [subSnap, contactSnap] = await Promise.all([
      db.doc(`subAccounts/${job.subAccountId}`).get(),
      db.doc(`contacts/${job.contactId}`).get(),
    ]);
    const sub = subSnap.data() as SubAccountDoc | undefined;
    if (sub && contactSnap.exists) {
      const contact = { id: contactSnap.id, ...contactSnap.data() } as Contact;
      const body = `Hi ${firstName(contact.name)}, ${sub.name || "we"} found some extra work needed on "${job.title}": ${lines.length} item${lines.length === 1 ? "" : "s"}, ${formatMoneyCode(job.currency, total)} in total. Please review and approve or decline here: ${url} (Anyone with this link can answer, so please don't forward it.)`;
      delivered = await deliverToContact({
        sub,
        contact,
        body,
        subject: `${sub.name || `Your ${terms.job}`}: approval needed`,
        agencyId: job.agencyId,
        subAccountId: job.subAccountId,
        label: "Extra work request",
        meta: { jobId: job.id ?? input.jobId, approvalId: ref.id },
      });
    }
  } catch (err) {
    console.warn("[field-approvals] message failed", err);
  }
  await recordFieldActivity(
    job.contactId,
    "field_job",
    `Extra work of ${formatMoneyCode(job.currency, total)} sent for approval on ${terms.job} ${job.number}.`,
    { jobId: input.jobId, approvalId: ref.id },
  );
  return { id: ref.id, delivered, url };
}

export async function cancelApproval(input: {
  subAccountId: string;
  jobId: string;
  approvalId: string;
}): Promise<void> {
  const ref = getAdminDb().doc(`jobApprovals/${input.approvalId}`);
  await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const a = snap.data();
    if (!a || a.subAccountId !== input.subAccountId || a.jobId !== input.jobId) {
      throw new FieldServicesError("Request not found.", 404);
    }
    if (a.status !== "pending") throw new FieldServicesError("The customer already answered this one.", 409);
    tx.update(ref, { status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
  });
}

export async function listApprovals(subAccountId: string, jobId: string) {
  const snap = await getAdminDb().collection("jobApprovals").where("jobId", "==", jobId).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as ExtraWorkApproval)
    .filter((a) => a.subAccountId === subAccountId)
    .map((a) => ({
      id: a.id,
      status: a.status,
      totalMinor: a.totalMinor,
      currency: a.currency,
      note: a.note,
      lines: a.lines,
      respondedBy: a.response?.name ?? "",
      createdAt: (a.createdAt as Timestamp | undefined)?.toMillis?.() ?? 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export type RespondResult = "ok" | "invalid" | "limited" | "answered";

/** The customer's answer from their status page. Approved lines join the job so they reach the invoice. */
export async function respondToApproval(input: {
  token: unknown;
  approvalId: unknown;
  decision: unknown;
  name: unknown;
  comment: unknown;
  ip: string;
  userAgent?: string;
}): Promise<RespondResult> {
  const byIp = await hitLimit(`ew:ip:${input.ip}`, 40, 3_600_000);
  if (!byIp.ok) return "limited";
  const parsed = readJobStatusToken(input.token);
  if (!parsed || typeof input.approvalId !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(input.approvalId)) {
    return "invalid";
  }
  const byJob = await hitLimit(`ew:job:${parsed.jobId}`, 30, 3_600_000);
  if (!byJob.ok) return "limited";
  const decision = input.decision === "approve" ? "approved" : input.decision === "decline" ? "declined" : null;
  const name = plain(input.name, 120);
  const comment = plain(input.comment, 500);
  if (!decision || (decision === "approved" && name.length < 2)) return "invalid";

  const db = getAdminDb();
  const jobRef = db.doc(`jobs/${parsed.jobId}`);
  const approvalRef = db.doc(`jobApprovals/${input.approvalId}`);

  const outcome = await db.runTransaction(async (tx) => {
    const [jobSnap, aSnap] = await Promise.all([tx.get(jobRef), tx.get(approvalRef)]);
    const job = jobSnap.data() as Job | undefined;
    const a = aSnap.data() as ExtraWorkApproval | undefined;
    if (!job || !a || a.jobId !== parsed.jobId || a.subAccountId !== job.subAccountId) return "invalid" as const;
    const subSnap = await tx.get(db.doc(`subAccounts/${job.subAccountId}`));
    if (!fieldServicesAvailable(subSnap.data())) return "invalid" as const;
    if (a.currency !== job.currency) return "invalid" as const;
    if ((job.statusTokenVersion ?? 1) !== parsed.version) return "invalid" as const;
    if (job.status === "closed" || job.status === "cancelled") return "invalid" as const;
    if (a.status !== "pending") return "answered" as const;
    const addLines = decision === "approved";
    if (addLines && openLineCount(job) + a.lines.length > MAX_JOB_LINES) return "invalid" as const;
    if (addLines && job.lineItems.length + a.lines.length > MAX_STORED_LINES) return "invalid" as const;
    tx.update(approvalRef, {
      status: decision,
      respondedAt: FieldValue.serverTimestamp(),
      response: {
        name,
        comment,
        ipHash: createHash("sha256").update(input.ip).digest("hex").slice(0, 32),
        userAgent: (input.userAgent ?? "").slice(0, 200),
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (addLines) {
      tx.update(jobRef, {
        lineItems: [...job.lineItems, ...a.lines.map((l) => ({ ...l, approvalId: aSnap.id }))],
        lineItemsVersion: (job.lineItemsVersion ?? 0) + 1,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return { job: { ...job, id: jobSnap.id }, approval: { ...a, id: aSnap.id } };
  });
  if (outcome === "invalid" || outcome === "answered") return outcome;

  const { job, approval } = outcome;
  const terms = await getJobTerms(job.subAccountId);
  const money = formatMoneyCode(approval.currency, approval.totalMinor);
  const text =
    decision === "approved"
      ? `"${name}" approved extra work of ${money} on ${terms.job} ${job.number}.`
      : `The customer declined extra work of ${money} on ${terms.job} ${job.number}.`;
  await recordFieldActivity(job.contactId, "field_job", text, { jobId: job.id, approvalId: approval.id });
  await createTaskServerSide({
    subAccountId: job.subAccountId,
    agencyId: job.agencyId,
    createdByUid: "field-services",
    mode: "live",
    title: decision === "approved" ? `Extra work approved: ${job.number}` : `Extra work declined: ${job.number}`,
    notes: `${text}${comment ? ` They said: "${comment}"` : ""}`,
    dueAt: null,
    contactId: job.contactId,
    dealId: null,
    eventId: null,
  }).catch((err) => console.warn("[field-approvals] task failed", err));
  await sendPushForEvent({
    subAccountId: job.subAccountId,
    agencyId: job.agencyId,
    title: decision === "approved" ? "Extra work approved" : "Extra work declined",
    body: text,
    territoryId: job.territoryId,
    url: `/sa/${job.subAccountId}/field-services`,
    tag: `extra-work-${approval.id}`,
  }).catch(() => {});
  return "ok";
}

export async function getCustomerLink(subAccountId: string, jobId: string): Promise<string> {
  const snap = await getAdminDb().doc(`jobs/${jobId}`).get();
  const job = snap.data() as Job | undefined;
  if (!job || job.subAccountId !== subAccountId) {
    throw new FieldServicesError(`${(await getJobTerms(subAccountId)).Job} not found.`, 404);
  }
  const url = jobStatusUrl(jobId, job.statusTokenVersion ?? 1);
  if (!url) {
    throw new FieldServicesError(
      "Customer links need AUTOMATIONS_TOKEN_SECRET and an https NEXT_PUBLIC_APP_URL to be set first.",
      503,
    );
  }
  return url;
}

/** Ends every status link already sent for this job. A new one is created next time it is needed. */
export async function revokeCustomerLink(subAccountId: string, jobId: string): Promise<void> {
  const ref = getAdminDb().doc(`jobs/${jobId}`);
  await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const job = snap.data() as Job | undefined;
    if (!job || job.subAccountId !== subAccountId) {
      throw new FieldServicesError(`${(await getJobTerms(subAccountId)).Job} not found.`, 404);
    }
    tx.update(ref, {
      statusTokenVersion: (job.statusTokenVersion ?? 1) + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

/** Called when a job closes or is cancelled, so the customer is not left with buttons that fail. */
export async function cancelPendingApprovals(jobId: string): Promise<void> {
  const db = getAdminDb();
  const snap = await db
    .collection("jobApprovals")
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
