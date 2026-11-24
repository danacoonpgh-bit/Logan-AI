import "server-only";

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const DOMAIN = "leadstack.field-portal.v1";

function signingKey(): Buffer {
  const secret = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("AUTOMATIONS_TOKEN_SECRET is required for the field portal");
  }
  return createHmac("sha256", secret).update(DOMAIN).digest();
}

export function portalSecretConfigured(): boolean {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  return !!s && s.length >= 16;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function mac(input: string): string {
  return b64url(createHmac("sha256", signingKey()).update(input).digest());
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function randomDigits(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

export function codeHash(scope: string, code: string): string {
  return mac(`code.${scope}.${code}`);
}

export function codeMatches(scope: string, code: string, expected: string): boolean {
  return equal(codeHash(scope, code), expected);
}

export function issueInviteToken(inviteId: string): { token: string; hash: string } {
  const nonce = randomId(12);
  const body = `fp1.inv.${inviteId}.${nonce}`;
  const token = `${body}.${mac(body)}`;
  return { token, hash: sha256(token) };
}

export function readInviteToken(token: unknown): { inviteId: string; hash: string } | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "fp1" || parts[1] !== "inv") return null;
  const [, , inviteId, nonce, sig] = parts;
  if (!/^[a-f0-9]{32}$/.test(inviteId) || !/^[a-f0-9]{24}$/.test(nonce)) return null;
  if (!equal(mac(`fp1.inv.${inviteId}.${nonce}`), sig)) return null;
  return { inviteId, hash: sha256(token) };
}

export interface SessionClaims {
  p: string;
  d: string;
  v: number;
  exp: number;
}

export function signSession(claims: SessionClaims): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const body = `fp1.ses.${payload}`;
  return `${body}.${mac(body)}`;
}

export function verifySession(token: unknown): SessionClaims | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "fp1" || parts[1] !== "ses") return null;
  const [, , payload, sig] = parts;
  if (!equal(mac(`fp1.ses.${payload}`), sig)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    if (
      typeof c.p !== "string" ||
      typeof c.d !== "string" ||
      typeof c.v !== "number" ||
      typeof c.exp !== "number" ||
      c.exp < Date.now()
    ) {
      return null;
    }
    return c;
  } catch {
    return null;
  }
}
