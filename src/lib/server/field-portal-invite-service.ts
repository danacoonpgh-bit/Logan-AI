import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { issueInviteToken, randomId, readInviteToken, portalSecretConfigured } from "@/lib/field-portal/crypto";
import { inWorkspace, maskIdentity, parseEmailIdentity, parseIdentity, scopedPersonId, type PortalIdentity } from "@/lib/field-portal/identity";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { hitLimit } from "@/lib/server/field-rate-limit";
import { stopRunningTimersForWorker } from "@/lib/server/field-time-service";
import {
  checkOtp,
  deliverOtp,
  isDormantPerson,
  issueDevice,
  signOutEverywhere,
} from "@/lib/server/field-portal-session-service";
import { sendEmail, tenantFrom, emailIsConfigured } from "@/lib/comms/resend";
import { INVITE_MAX_ATTEMPTS, INVITE_TTL_MS } from "@/types/field-portal";
import { MAX_FIELD_WORKERS, type FieldWorker, type FieldWorkerKind } from "@/types/field-services";
import type { SubAccountDoc } from "@/types";

const KINDS: FieldWorkerKind[] = ["employee", "contractor", "owner"];
const COLORS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#0891b2", "#db2777", "#ca8a04", "#475569"];

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
}

export interface InviteResult {
  workerId: string;
  delivered: "sent" | "queued_failed";
}

async function deliver(input: {
  subAccountId: string;
  identity: PortalIdentity;
  token: string;
  businessName: string;
  sub: SubAccountDoc;
}): Promise<boolean> {
  const link = `${appUrl()}/field/join#t=${input.token}`;
  const text = `${input.businessName} invited you to their crew app. Open this link on your phone and we'll send you a code to sign in: ${link}`;
  // Invites are emailed only.
  if (input.identity.kind !== "email" || !emailIsConfigured()) return false;
  try {
    await sendEmail({
      to: input.identity.value,
      subject: `${input.businessName} invited you to their crew app`,
      text,
      from: tenantFrom(input.sub),
      subAccount: input.sub,
    });
    return true;
  } catch (err) {
    console.warn("[field-portal] invite delivery failed", err);
    return false;
  }
}

async function mintInvite(input: {
  agencyId: string;
  subAccountId: string;
  workerId: string;
  identity: PortalIdentity;
  createdByUid: string;
  businessName: string;
  sub: SubAccountDoc;
}): Promise<InviteResult> {
  if (!portalSecretConfigured()) {
    throw new FieldServicesError("The crew app needs AUTOMATIONS_TOKEN_SECRET to be set first.", 503);
  }
  if (!/^https:\/\//.test(appUrl())) {
    throw new FieldServicesError("The crew app needs NEXT_PUBLIC_APP_URL set to your https address first.", 503);
  }
  const perSub = await hitLimit(`inv:sa:${input.subAccountId}`, 30, 24 * 3_600_000);
  const perId = await hitLimit(`inv:id:${input.subAccountId}:${input.identity.key}`, 3, 24 * 3_600_000);
  if (!perSub.ok || !perId.ok) {
    throw new FieldServicesError("Too many invites for now. Try again tomorrow.", 429);
  }

  const db = getAdminDb();
  const open = await db
    .collection("fieldInvites")
    .where("workerId", "==", input.workerId)
    .where("consumedAt", "==", null)
    .get();
  const batch = db.batch();
  for (const d of open.docs) batch.delete(d.ref);

  const inviteId = randomId(16);
  const { token, hash } = issueInviteToken(inviteId);
  batch.set(db.doc(`fieldInvites/${inviteId}`), {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    workerId: input.workerId,
    personKey: input.identity.key,
    kind: input.identity.kind,
    tokenHash: hash,
    attempts: 0,
    expiresAt: Timestamp.fromMillis(Date.now() + INVITE_TTL_MS),
    consumedAt: null,
    createdByUid: input.createdByUid,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.update(db.doc(`fieldWorkers/${input.workerId}`), {
    portalStatus: "invited",
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  const sent = await deliver({
    subAccountId: input.subAccountId,
    identity: input.identity,
    token,
    businessName: input.businessName,
    sub: input.sub,
  });
  return { workerId: input.workerId, delivered: sent ? "sent" : "queued_failed" };
}

async function loadSub(subAccountId: string): Promise<{ sub: SubAccountDoc; businessName: string }> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = snap.data() as SubAccountDoc | undefined;
  if (!sub) throw new FieldServicesError("Workspace not found.", 404);
  return { sub, businessName: (sub.name as string) || "Your employer" };
}

export async function createPortalWorker(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  body: {
    name?: string;
    identifier?: string;
    kind?: string;
    /** Optional contact number. Never used to sign in. */
    phone?: string;
    canHandlePrices?: boolean;
    canSeeCustomerContact?: boolean;
  };
}): Promise<InviteResult> {
  const { sub, businessName } = await loadSub(input.subAccountId);
  const identity = parseIdentity(input.body.identifier, (sub as { defaultPhoneCountry?: string }).defaultPhoneCountry);
  if (!identity || identity.kind !== "email") throw new FieldServicesError("Enter a valid email address.");
  const name = clean(input.body.name, 120);
  if (!name) throw new FieldServicesError("Enter the person's name.");

  const db = getAdminDb();
  const existing = await db.collection("fieldWorkers").where("subAccountId", "==", input.subAccountId).get();
  if (existing.docs.filter((d) => d.data().status === "active").length >= MAX_FIELD_WORKERS) {
    throw new FieldServicesError(`A workspace can have at most ${MAX_FIELD_WORKERS} worker profiles.`);
  }
  const dup = existing.docs.find(
    (d) =>
      d.data().status === "active" &&
      d.data().email === identity.value,
  );
  if (dup) throw new FieldServicesError("Someone with that email is already on your team.", 409);

  const kind = KINDS.includes(input.body.kind as FieldWorkerKind)
    ? (input.body.kind as FieldWorkerKind)
    : "employee";
  const ref = db.collection("fieldWorkers").doc();
  const doc: Omit<FieldWorker, "id"> = {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    memberUid: "",
    name,
    kind,
    phone: clean(input.body.phone, 40),
    email: identity.value,
    crewAccess: true,
    color: COLORS[existing.size % COLORS.length],
    status: "active",
    canHandlePrices: input.body.canHandlePrices === true,
    canSeeCustomerContact: input.body.canSeeCustomerContact !== false,
    personId: null,
    portalStatus: "invited",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);
  try {
    return await mintInvite({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      workerId: ref.id,
      identity,
      createdByUid: input.createdByUid,
      businessName,
      sub,
    });
  } catch (err) {
    await ref.delete().catch(() => {});
    throw err;
  }
}

async function loadPortalWorker(subAccountId: string, workerId: string) {
  const snap = await getAdminDb().doc(`fieldWorkers/${workerId}`).get();
  const w = snap.data() as Omit<FieldWorker, "id"> | undefined;
  if (!w || w.subAccountId !== subAccountId || w.memberUid) {
    throw new FieldServicesError("Worker not found.", 404);
  }
  return { ref: snap.ref, worker: w };
}

export async function resendPortalInvite(input: {
  subAccountId: string;
  workerId: string;
  createdByUid: string;
}): Promise<InviteResult> {
  const { worker } = await loadPortalWorker(input.subAccountId, input.workerId);
  if (worker.status !== "active") throw new FieldServicesError("Restore this worker first.", 409);
  if (worker.crewAccess === false) throw new FieldServicesError("Crew app access is switched off for this person.", 409);
  if (worker.portalStatus === "active") {
    throw new FieldServicesError("This person has already joined.", 409);
  }
  const { sub, businessName } = await loadSub(input.subAccountId);
  const identity = parseEmailIdentity(worker.email);
  if (!identity) throw new FieldServicesError("This person has no valid email address.");
  return mintInvite({
    agencyId: worker.agencyId,
    subAccountId: input.subAccountId,
    workerId: input.workerId,
    identity,
    createdByUid: input.createdByUid,
    businessName,
    sub,
  });
}

/** Emails the business's crew app address so the person can sign in with their email. Works for members and crew. */
export async function sendCrewAppLink(input: { subAccountId: string; workerId: string }): Promise<{ delivered: boolean }> {
  const snap = await getAdminDb().doc(`fieldWorkers/${input.workerId}`).get();
  const worker = snap.data() as Omit<FieldWorker, "id"> | undefined;
  if (!worker || worker.subAccountId !== input.subAccountId) throw new FieldServicesError("Worker not found.", 404);
  if (worker.status !== "active") throw new FieldServicesError("Restore this worker first.", 409);
  if (worker.crewAccess === false) throw new FieldServicesError("Crew app access is switched off for this person.", 409);
  const identity = parseEmailIdentity(worker.email);
  if (!identity) throw new FieldServicesError("This person has no valid email address.");
  if (!/^https:\/\//.test(appUrl())) {
    throw new FieldServicesError("The crew app needs NEXT_PUBLIC_APP_URL set to your https address first.", 503);
  }
  const cap = await hitLimit(`crewlink:${input.workerId}`, 5, 24 * 3_600_000);
  if (!cap.ok) throw new FieldServicesError("Too many links sent to this person today. Try again tomorrow.", 429);
  if (!emailIsConfigured()) return { delivered: false };
  const { sub, businessName } = await loadSub(input.subAccountId);
  try {
    await sendEmail({
      to: identity.value,
      subject: `Sign in to the ${businessName} crew app`,
      text: `Open this link and enter your email. We'll send you a 6-digit code to sign in: ${appUrl()}/field/${input.subAccountId}`,
      from: tenantFrom(sub),
      subAccount: sub,
    });
    return { delivered: true };
  } catch (err) {
    console.warn("[field-portal] crew app link delivery failed", err);
    return { delivered: false };
  }
}

export async function revokePortalLink(input: { subAccountId: string; workerId: string }): Promise<void> {
  const { ref } = await loadPortalWorker(input.subAccountId, input.workerId);
  const db = getAdminDb();
  const open = await db
    .collection("fieldInvites")
    .where("workerId", "==", input.workerId)
    .where("consumedAt", "==", null)
    .get();
  const batch = db.batch();
  for (const d of open.docs) batch.delete(d.ref);
  batch.update(ref, { portalStatus: "revoked", personId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  await stopRunningTimersForWorker(input.subAccountId, input.workerId).catch(() => {});
}

export interface InvitePreview {
  subAccountId: string;
  businessName: string;
  workerName: string;
  /** Masked number or email the sign-in code goes to. */
  sentTo: string;
}

export async function previewInvite(token: unknown, ip: string): Promise<InvitePreview | null> {
  const lim = await hitLimit(`inv:prev:ip:${ip}`, 60, 3_600_000);
  if (!lim.ok) return null;
  const parsed = readInviteToken(token);
  if (!parsed) return null;
  const snap = await getAdminDb().doc(`fieldInvites/${parsed.inviteId}`).get();
  const inv = snap.data();
  if (!inv || inv.consumedAt || inv.tokenHash !== parsed.hash) return null;
  if ((inv.expiresAt as Timestamp).toMillis() < Date.now()) return null;
  const [sub, worker] = await Promise.all([
    getAdminDb().doc(`subAccounts/${inv.subAccountId}`).get(),
    getAdminDb().doc(`fieldWorkers/${inv.workerId}`).get(),
  ]);
  if (!sub.exists || !worker.exists || !fieldServicesAvailable(sub.data())) return null;
  const identity = typeof inv.personKey === "string" ? parseIdentity(inv.personKey.slice(2)) : null;
  if (!identity) return null;
  return {
    subAccountId: inv.subAccountId as string,
    businessName: (sub.data()?.name as string) || "Your employer",
    workerName: (worker.data()?.name as string) || "",
    sentTo: maskIdentity(identity),
  };
}

export type AcceptResult =
  | { ok: true; token: string; deviceId: string; subAccountId: string }
  | { ok: false; reason: "invalid" | "limited"; retryAfterSec?: number }
  | { ok: false; reason: "otp_required"; sentTo: string; sent: boolean };

export async function acceptInvite(input: {
  token: unknown;
  otp?: unknown;
  ip: string;
  userAgent: string;
}): Promise<AcceptResult> {
  const lim = await hitLimit(`inv:acc:ip:${input.ip}`, 20, 3_600_000);
  if (!lim.ok) return { ok: false, reason: "limited", retryAfterSec: lim.retryAfterSec };
  const parsed = readInviteToken(input.token);
  if (!parsed) return { ok: false, reason: "invalid" };

  const db = getAdminDb();
  const inviteRef = db.doc(`fieldInvites/${parsed.inviteId}`);

  const pre = (await inviteRef.get()).data();
  if (
    !pre ||
    pre.consumedAt ||
    pre.tokenHash !== parsed.hash ||
    typeof pre.personKey !== "string" ||
    (pre.expiresAt as Timestamp).toMillis() < Date.now() ||
    (pre.codeHash && ((pre.attempts as number) ?? 0) >= INVITE_MAX_ATTEMPTS)
  ) {
    return { ok: false, reason: "invalid" };
  }
  const parsed2 = parseIdentity(pre.personKey.slice(2));
  if (!parsed2 || parsed2.key !== pre.personKey) return { ok: false, reason: "invalid" };
  const identity = inWorkspace(parsed2, pre.subAccountId as string);
  const preSub = await db.doc(`subAccounts/${pre.subAccountId}`).get();
  if (!fieldServicesAvailable(preSub.data())) return { ok: false, reason: "invalid" };
  const preWorker = (await db.doc(`fieldWorkers/${pre.workerId}`).get()).data();
  if (
    !preWorker ||
    preWorker.status !== "active" ||
    preWorker.memberUid ||
    preWorker.portalStatus === "revoked" ||
    parseIdentity(preWorker.email || preWorker.phone)?.key !== pre.personKey
  ) {
    return { ok: false, reason: "invalid" };
  }
  const wasDormant = await isDormantPerson(identity.personId);

  // The link can pass through the inviting workspace's own phone account, so the person proves the
  // number or email is theirs with a code sent from the platform.
  const otp = typeof input.otp === "string" ? input.otp.trim() : "";
  if (!otp) {
    const cool = await hitLimit(`otp:req:cool:${identity.personId}`, 1, 30_000);
    const hourly = cool.ok ? await hitLimit(`otp:req:id:${identity.personId}`, 8, 3_600_000) : cool;
    const sent = hourly.ok ? (await deliverOtp(identity, pre.subAccountId as string)) === "sent" : false;
    return { ok: false, reason: "otp_required", sentTo: maskIdentity(identity), sent };
  }
  const res = await checkOtp(identity, otp, input.ip);
  if (res === "limited") return { ok: false, reason: "limited", retryAfterSec: 3_600 };
  if (res === "bad") return { ok: false, reason: "invalid" };

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(inviteRef);
    const inv = snap.data();
    if (!inv || inv.consumedAt || inv.tokenHash !== parsed.hash) return null;
    if ((inv.expiresAt as Timestamp).toMillis() < Date.now()) return null;
    if (inv.codeHash && ((inv.attempts as number) ?? 0) >= INVITE_MAX_ATTEMPTS) return null;
    const workerRef = db.doc(`fieldWorkers/${inv.workerId}`);
    const worker = (await tx.get(workerRef)).data();
    if (!worker || worker.status !== "active" || worker.memberUid || worker.portalStatus === "revoked") {
      return null;
    }
    if (parseIdentity(worker.email || worker.phone)?.key !== inv.personKey) return null;
    const personId = scopedPersonId(inv.subAccountId as string, inv.personKey as string);
    const personRef = db.doc(`fieldPersons/${personId}`);
    const person = (await tx.get(personRef)).data();
    if (person?.status === "blocked") return null;
    if (!person) {
      tx.set(personRef, {
        kind: inv.kind,
        phone: inv.kind === "phone" ? (inv.personKey as string).slice(2) : null,
        email: inv.kind === "email" ? (inv.personKey as string).slice(2) : null,
        subAccountId: inv.subAccountId,
        name: worker.name,
        tokenVersion: 1,
        status: "active",
        blockedSubAccountIds: [],
        smsBlocked: false,
        lastActiveAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(inviteRef, { consumedAt: FieldValue.serverTimestamp() });
    tx.update(workerRef, {
      personId,
      portalStatus: "active",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { personId };
  });
  if (!outcome) return { ok: false, reason: "invalid" };

  if (wasDormant) await signOutEverywhere(outcome.personId);
  const device = await issueDevice(outcome.personId, input.userAgent);
  return { ok: true, token: device.token, deviceId: device.deviceId, subAccountId: pre.subAccountId as string };
}
