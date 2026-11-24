import "server-only";

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { fieldServicesAvailable } from "@/lib/field-services/availability";
import { hitLimit, peekLimit } from "@/lib/server/field-rate-limit";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import type { Contact } from "@/types/contacts";
import type { FieldServicesConfig } from "@/types/field-services";
import type { SubAccountDoc } from "@/types/tenancy";

const PROD = process.env.NODE_ENV === "production";
export const CUSTOMER_COOKIE = PROD ? "__Host-ls_cust" : "ls_cust";

const SESSION_MS = 30 * 24 * 3_600_000;
const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const DOMAIN = "leadstack.field-customer.v1";
const ID = /^[A-Za-z0-9_-]{6,128}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function key(): Buffer {
  const secret = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!secret || secret.length < 16) throw new Error("AUTOMATIONS_TOKEN_SECRET is required for the customer portal");
  return createHmac("sha256", secret).update(DOMAIN).digest();
}

function mac(input: string): string {
  return createHmac("sha256", key()).update(input).digest("base64url");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function customerCookieName(subAccountId: string): string {
  return `${CUSTOMER_COOKIE}_${subAccountId}`;
}

export function customerCookieHeader(token: string, subAccountId: string): string {
  return `${customerCookieName(subAccountId)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}${PROD ? "; Secure" : ""}`;
}

export function clearCustomerCookieHeader(subAccountId: string): string {
  return `${customerCookieName(subAccountId)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? "; Secure" : ""}`;
}

export interface PortalAccess {
  sub: SubAccountDoc & { id: string };
  config: FieldServicesConfig;
}

/** The workspace, if its customer portal is switched on. */
export async function requirePortalOpen(subAccountId: string): Promise<PortalAccess> {
  if (!ID.test(subAccountId)) throw new FieldServicesError("The customer portal isn't available.", 404);
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) throw new FieldServicesError("The customer portal isn't available.", 404);
  const sub = { ...(snap.data() as SubAccountDoc), id: snap.id };
  const config = await getFieldServicesConfig(subAccountId);
  if (!fieldServicesAvailable(sub) || config.customerPortalEnabled !== true) {
    throw new FieldServicesError("The customer portal isn't available.", 404);
  }
  return { sub, config };
}

export interface CustomerIdentity {
  /** The email address, lower-cased. */
  value: string;
  /** As typed, for contacts saved before addresses were lower-cased. */
  typed: string;
  /** Stable key for limits, so the same person can't dodge them by changing the case. */
  key: string;
}

/**
 * Email only: a code goes to the address on the contact, whereas anyone with a contact's email can add a phone number to it.
 */
export function parseIdentity(raw: unknown): CustomerIdentity {
  const text = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
  const value = text.toLowerCase();
  if (!EMAIL.test(value)) throw new FieldServicesError("Enter the email address you gave us.");
  return { value, typed: text, key: `e:${value}` };
}

/** The contact who owns this address and has made a request: the portal is not for every lead in the CRM. */
async function findCustomer(subAccountId: string, identity: CustomerIdentity): Promise<Contact | null> {
  const db = getAdminDb();
  const lookup = (value: string) =>
    db.collection("contacts").where("subAccountId", "==", subAccountId).where("email", "==", value).limit(10).get();
  let found = await lookup(identity.value);
  if (found.empty && identity.typed !== identity.value) found = await lookup(identity.typed);
  // Several contacts can share an address: take the one that has made a request.
  for (const doc of found.docs) {
    const contact = { id: doc.id, ...doc.data() } as Contact;
    const [jobs, requests] = await Promise.all([
      db.collection("jobs").where("subAccountId", "==", subAccountId).where("contactId", "==", contact.id).limit(1).get(),
      db.collection("serviceRequests").where("subAccountId", "==", subAccountId).where("contactId", "==", contact.id).limit(1).get(),
    ]);
    if (!jobs.empty || !requests.empty) return contact;
  }
  return null;
}

function codeHash(scope: string, code: string): string {
  return mac(`otp.${scope}.${code}`);
}

function otpRef(subAccountId: string, contactId: string) {
  return getAdminDb().doc(`customerOtps/${subAccountId}_${contactId}`);
}

/** Checks the limits and returns, so the caller answers every request the same way. Sending happens apart. */
export async function allowCodeRequest(
  subAccountId: string,
  identity: CustomerIdentity,
  ip: string,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const cool = await hitLimit(`cotp:cool:${subAccountId}:${identity.key}`, 1, 60_000);
  if (!cool.ok) return cool;
  const byId = await hitLimit(`cotp:id:${subAccountId}:${identity.key}`, 8, 3_600_000);
  if (!byId.ok) return byId;
  const byIp = await hitLimit(`cotp:ip:${ip}`, 30, 3_600_000);
  if (!byIp.ok) return byIp;
  return hitLimit(`cotp:page:${subAccountId}`, 300, 3_600_000);
}

/** Emails a one-time code to a customer who has made a request. Quietly does nothing for anyone else. */
export async function sendCustomerCode(sub: SubAccountDoc & { id: string }, identity: CustomerIdentity): Promise<void> {
  try {
    const contact = await findCustomer(sub.id, identity);
    if (!contact) {
      console.info("[field-customer] no sign-in code sent: no customer with a request for that address", sub.id);
      return;
    }
    // Nothing is stored or counted unless a message can actually go out.
    if (!emailIsConfigured() || contact.emailBouncedAt) {
      console.info("[field-customer] no sign-in code sent: email not set up or the address bounced before", sub.id, contact.id);
      return;
    }
    const ref = otpRef(sub.id, contact.id);
    const prior = (await ref.get()).data() as { createdAtMs?: number } | undefined;
    if (prior?.createdAtMs && Date.now() - prior.createdAtMs < 60_000) return;
    if (!(await hitLimit(`cotp:day:${sub.id}:${contact.id}`, 15, 86_400_000)).ok) {
      console.info("[field-customer] no sign-in code sent: daily limit reached", sub.id, contact.id);
      return;
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await ref.set({
      codeHash: codeHash(`${sub.id}.${contact.id}`, code),
      attempts: 0,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + OTP_TTL_MS,
    });
    const portalName = (await getFieldServicesConfig(sub.id)).portalName || sub.name || "customer";
    // Sent straight out and never written to the contact's message thread, which staff can read.
    await sendEmail({
      to: identity.value,
      subject: "Your sign-in code",
      text: `Your ${portalName} sign-in code is ${code}. It expires in 10 minutes. Don't share it.`,
      from: tenantFrom(sub),
      meter: { subAccountId: sub.id },
    });
  } catch (err) {
    console.warn("[field-customer] sending a sign-in code failed", err);
  }
}

/** Checks a code and signs the customer in. Wrong guesses count against the identity and the caller. */
export async function verifyCustomerCode(
  sub: SubAccountDoc & { id: string },
  identity: CustomerIdentity,
  codeRaw: unknown,
  ip: string,
  userAgent: string,
): Promise<{ token: string } | { error: "limited" } | null> {
  const failId = `cotp:fail:id:${sub.id}:${identity.key}`;
  const failIp = `cotp:fail:ip:${ip}`;
  if (!(await peekLimit(failId, 30, 3_600_000)).ok || !(await peekLimit(failIp, 40, 3_600_000)).ok) {
    return { error: "limited" };
  }
  const fail = async (): Promise<null> => {
    await Promise.all([hitLimit(failId, 30, 3_600_000), hitLimit(failIp, 40, 3_600_000)]);
    return null;
  };
  const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
  if (!/^\d{6}$/.test(code)) return fail();

  const contact = await findCustomer(sub.id, identity);
  if (!contact) return fail();
  const db = getAdminDb();
  const ref = otpRef(sub.id, contact.id);
  const ok = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data() as { codeHash: string; attempts: number; expiresAtMs: number } | undefined;
    if (!d || d.expiresAtMs < Date.now() || d.attempts >= OTP_MAX_ATTEMPTS) return false;
    if (!same(codeHash(`${sub.id}.${contact.id}`, code), d.codeHash)) {
      tx.update(ref, { attempts: d.attempts + 1 });
      return false;
    }
    tx.delete(ref);
    return true;
  });
  if (!ok) return fail();

  const sessionId = randomBytes(16).toString("hex");
  const now = Date.now();
  await db.doc(`customerSessions/${sessionId}`).set({
    subAccountId: sub.id,
    contactId: contact.id,
    label: userAgent.slice(0, 160),
    createdAtMs: now,
    expiresAtMs: now + SESSION_MS,
    createdAt: FieldValue.serverTimestamp(),
  });
  const body = `fc1.${sessionId}`;
  return { token: `${body}.${mac(body)}` };
}

export interface CustomerSession {
  sessionId: string;
  contactId: string;
}

function readToken(token: unknown): string | null {
  if (typeof token !== "string" || token.length > 120) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "fc1" || !/^[a-f0-9]{32}$/.test(parts[1])) return null;
  return same(mac(`fc1.${parts[1]}`), parts[2]) ? parts[1] : null;
}

/** The signed-in customer for this workspace, or null. A session from another workspace never matches. */
export async function readCustomerSession(
  cookieValue: string | undefined,
  subAccountId: string,
): Promise<CustomerSession | null> {
  const sessionId = readToken(cookieValue);
  if (!sessionId) return null;
  const d = (await getAdminDb().doc(`customerSessions/${sessionId}`).get()).data();
  if (!d || d.subAccountId !== subAccountId || typeof d.contactId !== "string" || d.expiresAtMs < Date.now()) return null;
  return { sessionId, contactId: d.contactId };
}

export async function endCustomerSession(cookieValue: string | undefined): Promise<void> {
  const sessionId = readToken(cookieValue);
  if (sessionId) await getAdminDb().doc(`customerSessions/${sessionId}`).delete().catch(() => {});
}
