import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  codeHash,
  codeMatches,
  randomDigits,
  randomId,
  signSession,
  verifySession,
} from "@/lib/field-portal/crypto";
import { legacyPersonId, maskIdentity, type PortalIdentity } from "@/lib/field-portal/identity";
import { hitLimit, peekLimit } from "@/lib/server/field-rate-limit";
import type { SubAccountDoc } from "@/types";
import { sendEmail, tenantFrom } from "@/lib/comms/resend";
import { runAfterResponse } from "@/lib/server/after-response";
import {
  MAX_DEVICES_PER_PERSON,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_SLIDING_MS,
} from "@/types/field-portal";

export interface PortalSession {
  personId: string;
  /** The one workspace this account belongs to. */
  subAccountId: string;
  deviceId: string;
  renewedToken: string | null;
}

export interface PortalLink {
  workerId: string;
  subAccountId: string;
  agencyId: string;
  businessName: string;
  name: string;
  email?: string;
  phone?: string;
  canHandlePrices: boolean;
  canSeeCustomerContact: boolean;
}

const RENEW_WITHIN_MS = 20 * 24 * 3_600_000;
const TOUCH_AFTER_MS = 3_600_000;

function tsMs(v: unknown): number {
  return (v as Timestamp | undefined)?.toMillis?.() ?? 0;
}

export async function issueDevice(personId: string, userAgent: string): Promise<{ token: string; deviceId: string }> {
  const db = getAdminDb();
  const personRef = db.doc(`fieldPersons/${personId}`);
  const person = (await personRef.get()).data();
  if (!person || person.status !== "active") throw new Error("person unavailable");

  const devices = await personRef.collection("devices").where("revokedAt", "==", null).get();
  const live = devices.docs
    .filter(
      (d) =>
        tsMs(d.data().absoluteExpiresAt) > Date.now() &&
        d.data().tokenVersion === person.tokenVersion,
    )
    .sort((a, b) => tsMs(a.data().lastSeenAt) - tsMs(b.data().lastSeenAt));
  for (const d of live.slice(0, Math.max(0, live.length - (MAX_DEVICES_PER_PERSON - 1)))) {
    await d.ref.update({ revokedAt: FieldValue.serverTimestamp() });
  }

  const deviceId = randomId(16);
  const now = Date.now();
  const absolute = now + SESSION_ABSOLUTE_MS;
  await personRef.collection("devices").doc(deviceId).set({
    label: userAgent.slice(0, 160),
    createdAt: FieldValue.serverTimestamp(),
    lastSeenAt: FieldValue.serverTimestamp(),
    absoluteExpiresAt: Timestamp.fromMillis(absolute),
    tokenVersion: person.tokenVersion as number,
    revokedAt: null,
  });
  await personRef.update({ lastActiveAt: FieldValue.serverTimestamp() });
  const token = signSession({
    p: personId,
    d: deviceId,
    v: person.tokenVersion as number,
    exp: Math.min(now + SESSION_SLIDING_MS, absolute),
  });
  return { token, deviceId };
}

export async function readSession(cookieValue: string | undefined): Promise<PortalSession | null> {
  const claims = verifySession(cookieValue);
  if (!claims) return null;
  const db = getAdminDb();
  const personRef = db.doc(`fieldPersons/${claims.p}`);
  const [personSnap, deviceSnap] = await Promise.all([
    personRef.get(),
    personRef.collection("devices").doc(claims.d).get(),
  ]);
  const person = personSnap.data();
  const device = deviceSnap.data();
  if (!person || !device) return null;
  if (person.status !== "active" || person.tokenVersion !== claims.v) return null;
  if (device.revokedAt || device.tokenVersion !== claims.v) return null;
  const absolute = tsMs(device.absoluteExpiresAt);
  if (absolute <= Date.now()) return null;

  const now = Date.now();
  if (now - tsMs(device.lastSeenAt) > TOUCH_AFTER_MS) {
    runAfterResponse(async () => {
      await deviceSnap.ref.update({ lastSeenAt: FieldValue.serverTimestamp() }).catch(() => {});
      await personRef.update({ lastActiveAt: FieldValue.serverTimestamp() }).catch(() => {});
    });
  }
  let renewedToken: string | null = null;
  if (claims.exp - now < RENEW_WITHIN_MS) {
    renewedToken = signSession({
      p: claims.p,
      d: claims.d,
      v: claims.v,
      exp: Math.min(now + SESSION_SLIDING_MS, absolute),
    });
  }
  return {
    personId: claims.p,
    subAccountId: typeof person.subAccountId === "string" ? person.subAccountId : "",
    deviceId: claims.d,
    renewedToken,
  };
}

async function deleteDocs(snap: FirebaseFirestore.QuerySnapshot): Promise<void> {
  if (snap.empty) return;
  const batch = getAdminDb().batch();
  for (const d of snap.docs) batch.delete(d.ref);
  await batch.commit();
}

export async function signOutDevice(personId: string, deviceId: string): Promise<void> {
  const db = getAdminDb();
  await db
    .doc(`fieldPersons/${personId}/devices/${deviceId}`)
    .update({ revokedAt: FieldValue.serverTimestamp() })
    .catch(() => {});
  await db
    .collection(`fieldPersons/${personId}/pushSubscriptions`)
    .where("deviceId", "==", deviceId)
    .get()
    .then(deleteDocs)
    .catch(() => {});
}

/** Ends every session and stops all alerts to this person's phones. */
export async function signOutEverywhere(personId: string): Promise<void> {
  const db = getAdminDb();
  await db.doc(`fieldPersons/${personId}`).update({
    tokenVersion: FieldValue.increment(1),
  });
  await db.collection(`fieldPersons/${personId}/pushSubscriptions`).get().then(deleteDocs).catch(() => {});
}

export async function listDevices(personId: string, currentDeviceId: string) {
  const personRef = getAdminDb().doc(`fieldPersons/${personId}`);
  const [person, snap] = await Promise.all([
    personRef.get(),
    personRef.collection("devices").where("revokedAt", "==", null).get(),
  ]);
  const version = person.data()?.tokenVersion;
  return snap.docs
    .filter((d) => tsMs(d.data().absoluteExpiresAt) > Date.now() && d.data().tokenVersion === version)
    .map((d) => ({
      id: d.id,
      label: (d.data().label as string) || "Phone",
      lastSeenAt: tsMs(d.data().lastSeenAt),
      current: d.id === currentDeviceId,
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export async function getPerson(personId: string) {
  const snap = await getAdminDb().doc(`fieldPersons/${personId}`).get();
  const d = snap.data();
  if (!d) return null;
  return {
    id: snap.id,
    name: (d.name as string) ?? "",
    phone: (d.phone as string | null) ?? null,
    email: (d.email as string | null) ?? null,
  };
}

export async function listActiveLinks(personId: string): Promise<PortalLink[]> {
  const db = getAdminDb();
  const person = (await db.doc(`fieldPersons/${personId}`).get()).data();
  const blocked = new Set<string>((person?.blockedSubAccountIds as string[] | undefined) ?? []);
  const snap = await db
    .collection("fieldWorkers")
    .where("personId", "==", personId)
    .where("portalStatus", "==", "active")
    .get();
  const links: PortalLink[] = [];
  for (const d of snap.docs) {
    const w = d.data();
    if (w.status !== "active" || blocked.has(w.subAccountId as string)) continue;
    const sub = (await db.doc(`subAccounts/${w.subAccountId}`).get()).data();
    if (!sub || !fieldServicesAvailable(sub)) continue;
    links.push({
      workerId: d.id,
      subAccountId: w.subAccountId as string,
      agencyId: w.agencyId as string,
      businessName: (sub.name as string) || "Your employer",
      name: (w.name as string) ?? "",
      email: (w.email as string) ?? "",
      phone: (w.phone as string) ?? "",
      canHandlePrices: w.canHandlePrices === true,
      canSeeCustomerContact: w.canSeeCustomerContact !== false,
    });
  }
  return links;
}

export async function requireLink(personId: string, subAccountId: string): Promise<PortalLink | null> {
  const links = await listActiveLinks(personId);
  return links.find((l) => l.subAccountId === subAccountId) ?? null;
}

const DORMANT_AFTER_MS = 120 * 24 * 3_600_000;

/** A person with no active crew or no recent use is treated as new when someone invites that number again. */
export async function isDormantPerson(personId: string): Promise<boolean> {
  const person = (await getAdminDb().doc(`fieldPersons/${personId}`).get()).data();
  if (!person) return false;
  if (Date.now() - tsMs(person.lastActiveAt) > DORMANT_AFTER_MS) return true;
  return (await listActiveLinks(personId)).length === 0;
}

/** A staff record with no account yet, this workspace's account, or the shared account from before accounts were split. */
function ownsRecord(personId: unknown, identity: PortalIdentity): boolean {
  if (typeof personId !== "string" || !personId) return true;
  return personId === identity.personId || personId === legacyPersonId(identity.key);
}

/** Staff on a team with crew app access on whose email matches, in any workspace where Field Services is available. */
async function eligibleStaff(identity: PortalIdentity): Promise<{ id: string; subAccountId: string }[]> {
  if (identity.kind !== "email" || !identity.subAccountId) return [];
  const db = getAdminDb();
  const snap = await db.collection("fieldWorkers").where("email", "==", identity.value).get();
  const out: { id: string; subAccountId: string }[] = [];
  for (const d of snap.docs) {
    const w = d.data();
    if (w.subAccountId !== identity.subAccountId) continue;
    if (w.status !== "active" || w.portalStatus === "revoked" || w.crewAccess === false) continue;
    if (!ownsRecord(w.personId, identity)) continue;
    const sub = (await db.doc(`subAccounts/${w.subAccountId}`).get()).data();
    if (!sub || !fieldServicesAvailable(sub)) continue;
    out.push({ id: d.id, subAccountId: w.subAccountId as string });
  }
  return out;
}

/** Once the emailed code is right, links every matching staff record to this person. Needs no invite. */
async function claimStaffAccess(identity: PortalIdentity): Promise<void> {
  const staff = await eligibleStaff(identity);
  if (staff.length === 0) return;
  const db = getAdminDb();
  const personRef = db.doc(`fieldPersons/${identity.personId}`);
  await db.runTransaction(async (tx) => {
    const person = (await tx.get(personRef)).data();
    if (person?.status === "blocked") return;
    const snaps = await Promise.all(staff.map((e) => tx.get(db.doc(`fieldWorkers/${e.id}`))));
    if (!person) {
      tx.set(personRef, {
        kind: "email",
        phone: null,
        email: identity.value,
        subAccountId: identity.subAccountId,
        name: (snaps[0]?.data()?.name as string | undefined) ?? "",
        tokenVersion: 1,
        status: "active",
        blockedSubAccountIds: [],
        smsBlocked: false,
        lastActiveAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    for (const snap of snaps) {
      const w = snap.data();
      if (!w || w.status !== "active" || w.portalStatus === "revoked" || w.crewAccess === false) continue;
      if (!ownsRecord(w.personId, identity)) continue;
      tx.update(snap.ref, { personId: identity.personId, portalStatus: "active", updatedAt: FieldValue.serverTimestamp() });
    }
  });
}

/** Creates a fresh one-time code for this person and sends it. Quietly does nothing if capped or blocked. */
export async function deliverOtp(identity: PortalIdentity, subAccountId: string): Promise<"sent" | "skipped"> {
  // Sign-in codes are emailed only.
  if (identity.kind !== "email") return "skipped";
  try {
    const db = getAdminDb();
    const person = (await db.doc(`fieldPersons/${identity.personId}`).get()).data();
    if (person && person.status !== "active") return "skipped";
    const otpRef = db.doc(`fieldOtps/${identity.personId}`);
    const prior = (await otpRef.get()).data() as { createdAtMs?: number; attempts?: number } | undefined;
    if (prior?.createdAtMs && Date.now() - prior.createdAtMs < 60_000 && (prior.attempts ?? 0) < OTP_MAX_ATTEMPTS) {
      return "skipped";
    }
    const daily = await hitLimit(`otp:day:${identity.personId}`, 15, 24 * 3_600_000);
    if (!daily.ok) return "skipped";
    const code = randomDigits(6);
    await otpRef.set({
      codeHash: codeHash(identity.personId, code),
      attempts: 0,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + OTP_TTL_MS,
      createdAt: FieldValue.serverTimestamp(),
    });
    const sub = (await db.doc(`subAccounts/${subAccountId}`).get()).data();
    const body = `Your sign-in code is ${code}. It expires in 10 minutes. Don't share it.`;
    await sendEmail({
      to: identity.value,
      subject: "Your sign-in code",
      text: body,
      from: tenantFrom(sub as SubAccountDoc),
    }).catch((err) => console.warn("[field-portal] otp email failed", err));
    return "sent";
  } catch (err) {
    console.warn("[field-portal] otp delivery failed", err);
    return "skipped";
  }
}

export async function requestOtp(
  identity: PortalIdentity,
  ip: string,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const cool = await hitLimit(`otp:req:cool:${identity.personId}`, 1, 30_000);
  if (!cool.ok) return cool;
  const byId = await hitLimit(`otp:req:id:${identity.personId}`, 8, 3_600_000);
  if (!byId.ok) return byId;
  const byIp = await hitLimit(`otp:req:ip:${ip}`, 30, 3_600_000);
  if (!byIp.ok) return byIp;
  const global = await hitLimit(`otp:req:global:${identity.subAccountId ?? "any"}`, 1_000, 3_600_000);
  if (!global.ok) return global;

  runAfterResponse(async () => {
    const links = await listActiveLinks(identity.personId).catch(() => []);
    if (links.length > 0) {
      await deliverOtp(identity, links[0].subAccountId);
      return;
    }
    const staff = await eligibleStaff(identity).catch(() => []);
    if (staff.length > 0) await deliverOtp(identity, staff[0].subAccountId);
  });
  return { ok: true, retryAfterSec: 0 };
}

/** Checks a code and uses it up. Failed guesses count against the identity and the caller's IP. */
export async function checkOtp(
  identity: PortalIdentity,
  code: string,
  ip: string,
): Promise<"ok" | "bad" | "limited"> {
  const failId = `otp:fail:id:${identity.personId}:${ip}`;
  const failIp = `otp:fail:ip:${ip}`;
  if (!(await peekLimit(failId, 30, 3_600_000)).ok) return "limited";
  if (!(await peekLimit(failIp, 40, 3_600_000)).ok) return "limited";
  const fail = async (): Promise<"bad"> => {
    await Promise.all([hitLimit(failId, 30, 3_600_000), hitLimit(failIp, 40, 3_600_000)]);
    return "bad";
  };
  if (!/^\d{6}$/.test(code)) return fail();

  const db = getAdminDb();
  const ref = db.doc(`fieldOtps/${identity.personId}`);
  const ok = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data() as { codeHash: string; attempts: number; expiresAtMs: number } | undefined;
    if (!d || d.expiresAtMs < Date.now() || d.attempts >= OTP_MAX_ATTEMPTS) return false;
    if (!codeMatches(identity.personId, code, d.codeHash)) {
      tx.update(ref, { attempts: d.attempts + 1 });
      return false;
    }
    tx.delete(ref);
    return true;
  });
  return ok ? "ok" : fail();
}

export async function verifyOtp(
  identity: PortalIdentity,
  code: string,
  ip: string,
  userAgent: string,
): Promise<{ token: string; deviceId: string } | { error: "limited"; retryAfterSec: number } | null> {
  const res = await checkOtp(identity, code, ip);
  if (res === "limited") return { error: "limited", retryAfterSec: 3_600 };
  if (res === "bad") return null;
  await claimStaffAccess(identity).catch(() => {});
  const links = await listActiveLinks(identity.personId);
  if (links.length === 0) return null;
  return issueDevice(identity.personId, userAgent);
}

export { maskIdentity };
