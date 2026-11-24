import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const DOMAIN = "leadstack.field-job-status.v1";

function key(): Buffer | null {
  const secret = process.env.AUTOMATIONS_TOKEN_SECRET;
  if (!secret || secret.length < 16) return null;
  return createHmac("sha256", secret).update(DOMAIN).digest();
}

function mac(jobId: string, version: number): string | null {
  const k = key();
  if (!k) return null;
  return createHmac("sha256", k).update(`${jobId}.${version}`).digest("base64url").slice(0, 22);
}

/** Deterministic, so every message about a job carries the same working link until it is revoked. */
export function jobStatusToken(jobId: string, version = 1): string | null {
  const m = mac(jobId, version);
  return m ? `${jobId}.${version}.${m}` : null;
}

export function readJobStatusToken(token: unknown): { jobId: string; version: number } | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [jobId, versionText, sig] = parts;
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(jobId) || !/^[1-9]\d{0,3}$/.test(versionText)) return null;
  const version = Number(versionText);
  const expected = mac(jobId, version);
  if (!expected) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { jobId, version };
}

export function jobStatusUrl(jobId: string, version = 1): string | null {
  const token = jobStatusToken(jobId, version);
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return token && /^https:\/\//.test(base) ? `${base}/j/${token}` : null;
}
