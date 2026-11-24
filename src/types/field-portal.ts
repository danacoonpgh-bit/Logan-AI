import type { Timestamp, FieldValue } from "firebase/firestore";

type Ts = Timestamp | FieldValue | Date | null;

export type PortalIdentifierKind = "phone" | "email";

/** One per human per deployment, keyed by a hash of the normalised phone or email. */
export interface FieldPerson {
  id: string;
  kind: PortalIdentifierKind;
  phone: string | null;
  email: string | null;
  name: string;
  tokenVersion: number;
  status: "active" | "blocked";
  blockedSubAccountIds: string[];
  smsBlocked: boolean;
  lastActiveAt: Ts;
  createdAt: Ts;
}

export interface FieldDevice {
  id: string;
  label: string;
  createdAt: Ts;
  lastSeenAt: Ts;
  absoluteExpiresAt: Ts;
  tokenVersion: number;
  revokedAt: Ts;
}

export type PortalLinkStatus = "none" | "invited" | "active" | "revoked";

export interface FieldInvite {
  id: string;
  agencyId: string;
  subAccountId: string;
  workerId: string;
  personKey: string;
  kind: PortalIdentifierKind;
  tokenHash: string;
  /** Set on invites made before sign-in moved to a single emailed or texted code. */
  codeHash?: string;
  attempts: number;
  expiresAt: Ts;
  consumedAt: Ts;
  createdByUid: string;
  createdAt: Ts;
}

export const INVITE_TTL_MS = 7 * 24 * 3_600_000;
export const INVITE_MAX_ATTEMPTS = 5;
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const SESSION_SLIDING_MS = 30 * 24 * 3_600_000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 3_600_000;
export const MAX_DEVICES_PER_PERSON = 8;
