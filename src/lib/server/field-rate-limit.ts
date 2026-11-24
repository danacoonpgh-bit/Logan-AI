import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sha256 } from "@/lib/field-portal/crypto";

export interface LimitResult {
  ok: boolean;
  retryAfterSec: number;
}

/** Fixed-window counter in Firestore, so the limit holds across serverless instances. Fails closed. */
export async function hitLimit(key: string, limit: number, windowMs: number): Promise<LimitResult> {
  const ref = getAdminDb().doc(`fieldRateLimits/${sha256(key)}`);
  try {
    return await getAdminDb().runTransaction(async (tx) => {
      const now = Date.now();
      const snap = await tx.get(ref);
      const d = snap.data() as { count: number; windowStart: number } | undefined;
      if (!d || now - d.windowStart >= windowMs) {
        tx.set(ref, { count: 1, windowStart: now, expiresAtMs: now + windowMs });
        return { ok: true, retryAfterSec: 0 };
      }
      if (d.count >= limit) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((d.windowStart + windowMs - now) / 1000)) };
      }
      tx.update(ref, { count: d.count + 1 });
      return { ok: true, retryAfterSec: 0 };
    });
  } catch (err) {
    console.error("[field-portal] rate limiter failed", err);
    return { ok: false, retryAfterSec: 60 };
  }
}

/** Reads a counter without adding to it. Fails closed. */
export async function peekLimit(key: string, limit: number, windowMs: number): Promise<LimitResult> {
  try {
    const snap = await getAdminDb().doc(`fieldRateLimits/${sha256(key)}`).get();
    const d = snap.data() as { count: number; windowStart: number } | undefined;
    const now = Date.now();
    if (!d || now - d.windowStart >= windowMs || d.count < limit) return { ok: true, retryAfterSec: 0 };
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((d.windowStart + windowMs - now) / 1000)) };
  } catch (err) {
    console.error("[field-portal] rate limiter failed", err);
    return { ok: false, retryAfterSec: 60 };
  }
}

export async function sweepFieldPortalExpired(now = Date.now()): Promise<number> {
  const db = getAdminDb();
  let removed = 0;
  for (const collection of ["fieldRateLimits", "fieldOtps"] as const) {
    for (let round = 0; round < 10; round++) {
      const snap = await db.collection(collection).where("expiresAtMs", "<", now).limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
      removed += snap.size;
      if (snap.size < 400) break;
    }
  }
  for (let round = 0; round < 10; round++) {
    const old = await db
      .collection("fieldInvites")
      .where("expiresAt", "<", Timestamp.fromMillis(now - 30 * 24 * 3_600_000))
      .limit(400)
      .get();
    if (old.empty) break;
    const batch = db.batch();
    for (const d of old.docs) batch.delete(d.ref);
    await batch.commit();
    removed += old.size;
    if (old.size < 400) break;
  }
  return removed;
}
