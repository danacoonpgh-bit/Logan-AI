import "server-only";

import { coercePhoneCountry, normalizePhoneE164 } from "@/lib/contacts/phone";
import { sha256 } from "@/lib/field-portal/crypto";
import type { PortalIdentifierKind } from "@/types/field-portal";

export interface PortalIdentity {
  kind: PortalIdentifierKind;
  value: string;
  key: string;
  personId: string;
  /** Set once the identity belongs to one workspace. Crew accounts are never shared between workspaces. */
  subAccountId?: string;
}

export const WORKSPACE_ID = /^[A-Za-z0-9_-]{6,128}$/;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The id crew accounts had before they were split by workspace. Only used to move older accounts across. */
export function legacyPersonId(key: string): string {
  return `fp_${sha256(key).slice(0, 32)}`;
}

export function scopedPersonId(subAccountId: string, key: string): string {
  return `fp_${sha256(`${subAccountId}|${key}`).slice(0, 32)}`;
}

/** The same person as an account of one workspace. */
export function inWorkspace(identity: PortalIdentity, subAccountId: string): PortalIdentity {
  return { ...identity, subAccountId, personId: scopedPersonId(subAccountId, identity.key) };
}

export function parseIdentity(raw: unknown, country?: string | null): PortalIdentity | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 200) return null;
  if (text.includes("@")) {
    const email = text.toLowerCase();
    if (!EMAIL.test(email)) return null;
    const key = `e:${email}`;
    return { kind: "email", value: email, key, personId: legacyPersonId(key) };
  }
  const e164 = normalizePhoneE164(text, coercePhoneCountry(country));
  if (!e164) return null;
  const key = `p:${e164}`;
  return { kind: "phone", value: e164, key, personId: legacyPersonId(key) };
}

export function maskIdentity(identity: Pick<PortalIdentity, "kind" | "value">): string {
  if (identity.kind === "phone") return `••• ${identity.value.slice(-3)}`;
  const [user, domain] = identity.value.split("@");
  return `${user.slice(0, 1)}•••@${domain}`;
}

/** The crew app signs in by email only. */
export function parseEmailIdentity(raw: unknown): PortalIdentity | null {
  const id = parseIdentity(raw);
  return id && id.kind === "email" ? id : null;
}
