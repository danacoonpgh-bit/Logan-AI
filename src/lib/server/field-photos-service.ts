import "server-only";

import { randomUUID } from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  imageDimensions,
  productImageBucketName,
  sniffImageType,
} from "@/lib/server/product-images-storage";
import {
  assertCanActOnVisit,
  type FieldActor,
} from "@/lib/server/field-access";
import { getFieldServicesConfig, getJobTerms } from "@/lib/server/field-services-config-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { recordFieldActivity } from "@/lib/server/field-events";
import type { Job, PhotoLabel, PhotoRef, Visit } from "@/types/field-services";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_THUMB_BYTES = 400 * 1024;
export const MAX_PHOTOS_PER_VISIT = 30;
export const MAX_PHOTOS_PER_WORKER_PER_DAY = 100;
export const WORKER_DELETE_WINDOW_MS = 10 * 60_000;

const LABELS: PhotoLabel[] = ["before", "after", "receipt", "issue", "other"];
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Unparseable files count as having metadata, so a crafted file cannot pass.
function hasMetadata(buf: Buffer, type: string): boolean {
  try {
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 4 <= buf.length) {
        if (buf[i] !== 0xff) return true;
        const marker = buf[i + 1];
        if (marker === 0xff) {
          i += 1; // fill byte
          continue;
        }
        if (marker === 0xda || marker === 0xd9) return false; // image data starts
        if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
          i += 2; // markers without a length
          continue;
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return true;
        if (marker === 0xe1) return true; // APP1 holds Exif and XMP
        i += 2 + len;
      }
      return true;
    }
    if (type === "image/png") {
      let i = 8;
      while (i + 8 <= buf.length) {
        const len = buf.readUInt32BE(i);
        const name = buf.subarray(i + 4, i + 8).toString("ascii");
        if (name === "eXIf" || name === "iTXt" || name === "tEXt" || name === "zTXt") return true;
        if (name === "IDAT") return false;
        i += 12 + len;
      }
      return true;
    }
    if (type === "image/webp") {
      let i = 12;
      while (i + 8 <= buf.length) {
        const name = buf.subarray(i, i + 4).toString("ascii");
        const len = buf.readUInt32LE(i + 4);
        if (name === "EXIF" || name === "XMP ") return true;
        i += 8 + len + (len % 2);
      }
      return false;
    }
  } catch {
    return true;
  }
  return true;
}

// Drops Exif/XMP (APP1) and Photoshop (APP13) segments. Null when the file cannot be walked safely.
function stripJpegMetadata(buf: Buffer): Buffer | null {
  try {
    const parts: Buffer[] = [buf.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xda) {
        parts.push(buf.subarray(i));
        return Buffer.concat(parts);
      }
      if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
        parts.push(buf.subarray(i, i + 2));
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2 || i + 2 + len > buf.length) return null;
      if (marker !== 0xe1 && marker !== 0xed) parts.push(buf.subarray(i, i + 2 + len));
      i += 2 + len;
    }
    return null;
  } catch {
    return null;
  }
}

function cleanImage(input: Buffer, max: number, what: string): { buf: Buffer; type: string } {
  if (input.length === 0 || input.length > max) {
    throw new FieldServicesError(`The ${what} is too large or empty.`, 413);
  }
  const type = sniffImageType(input);
  if (!type) throw new FieldServicesError(`The ${what} must be a JPEG, PNG or WebP image.`);
  if (type === "image/jpeg") {
    const cleaned = stripJpegMetadata(input);
    if (!cleaned) throw new FieldServicesError(`The ${what} could not be read. Try another photo.`);
    return { buf: cleaned, type };
  }
  if (hasMetadata(input, type)) {
    throw new FieldServicesError(`The ${what} carries metadata. Use a JPEG from the camera.`);
  }
  return { buf: input, type };
}

function bucket() {
  const name = productImageBucketName();
  if (!name) {
    throw new FieldServicesError(
      "Photo uploads need Firebase Storage. Ask whoever runs the deployment to enable it.",
      503,
    );
  }
  return getStorage().bucket(name);
}

async function loadVisit(subAccountId: string, visitId: string) {
  const snap = await getAdminDb().doc(`visits/${visitId}`).get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Visit not found.", 404);
  }
  return { id: snap.id, ...snap.data() } as Visit;
}

export async function uploadVisitPhoto(input: {
  subAccountId: string;
  visitId: string;
  actor: FieldActor;
  photo: Buffer;
  thumb: Buffer | null;
  label: string;
  note: string;
}): Promise<{ photo: PhotoRef }> {
  const db = getAdminDb();
  const visit = await loadVisit(input.subAccountId, input.visitId);
  assertCanActOnVisit(input.actor, visit);
  const job = (await db.doc(`jobs/${visit.jobId}`).get()).data() as Job | undefined;
  if (!job || job.status === "closed" || job.status === "cancelled") {
    throw new FieldServicesError(`This ${(await getJobTerms(input.subAccountId)).job} is closed.`, 409);
  }

  const main = cleanImage(input.photo, MAX_PHOTO_BYTES, "photo");
  const type = main.type;
  const dims = imageDimensions(main.buf, type);
  if (!dims) throw new FieldServicesError("Couldn't read that photo.");
  const small = input.thumb ? cleanImage(input.thumb, MAX_THUMB_BYTES, "thumbnail") : null;
  const thumbType = small?.type ?? null;
  const label = LABELS.includes(input.label as PhotoLabel) ? (input.label as PhotoLabel) : "other";

  const config = await getFieldServicesConfig(input.subAccountId);
  const bytes = main.buf.length + (small?.buf.length ?? 0);
  const workerKey = input.actor.workerId ?? `office_${input.actor.uid}`;
  const day = new Date().toISOString().slice(0, 10);
  const storageRef = db.doc(`subAccounts/${input.subAccountId}/counters/fieldStorage`);
  const dailyRef = db.doc(`subAccounts/${input.subAccountId}/counters/fieldPhotos_${workerKey}`);
  const visitRef = db.doc(`visits/${visit.id}`);
  const id = randomUUID();
  const ext = EXT[type];
  const path = `fieldwork/${visit.subAccountId}/${visit.jobId}/${visit.id}/${id}.${ext}`;
  const thumbPath = small ? `fieldwork/${visit.subAccountId}/${visit.jobId}/${visit.id}/${id}_t.${EXT[thumbType!]}` : null;

  const ref: PhotoRef = {
    id,
    path,
    label,
    takenAt: Date.now(),
    byWorkerId: input.actor.workerId,
    width: dims.width,
    height: dims.height,
    thumbPath,
    note: input.note.trim().slice(0, 300) || null,
  };

  await db.runTransaction(async (tx) => {
    const [vSnap, sSnap, dSnap] = await Promise.all([tx.get(visitRef), tx.get(storageRef), tx.get(dailyRef)]);
    const photos = ((vSnap.data()?.photos as PhotoRef[] | undefined) ?? []);
    if (photos.length >= MAX_PHOTOS_PER_VISIT) {
      throw new FieldServicesError(`A visit can hold at most ${MAX_PHOTOS_PER_VISIT} photos.`, 409);
    }
    const used = (sSnap.data()?.bytes as number | undefined) ?? 0;
    if (used + bytes > config.photoStorageCapMb * 1024 * 1024) {
      throw new FieldServicesError("This workspace's photo storage is full. Ask the office to free some space.", 409);
    }
    const d = dSnap.data();
    const todays = d?.day === day ? (d.n as number) : 0;
    if (todays >= MAX_PHOTOS_PER_WORKER_PER_DAY) {
      throw new FieldServicesError("That's the daily photo limit for one person.", 429);
    }
    tx.update(visitRef, { photos: [...photos, ref], updatedAt: FieldValue.serverTimestamp() });
    tx.set(storageRef, { bytes: used + bytes, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(dailyRef, { day, n: todays + 1 });
  });

  try {
    const b = bucket();
    await b.file(path).save(main.buf, { contentType: type, resumable: false });
    if (small && thumbPath) {
      await b.file(thumbPath).save(small.buf, { contentType: thumbType!, resumable: false });
    }
  } catch (err) {
    const b2 = bucket();
    await Promise.all(
      [path, thumbPath].filter((p): p is string => !!p).map((p) => b2.file(p).delete().catch(() => {})),
    );
    await db.runTransaction(async (tx) => {
      const [vSnap, sSnap] = await Promise.all([tx.get(visitRef), tx.get(storageRef)]);
      const photos = ((vSnap.data()?.photos as PhotoRef[] | undefined) ?? []).filter((p) => p.id !== id);
      tx.update(visitRef, { photos });
      tx.set(storageRef, { bytes: Math.max(0, ((sSnap.data()?.bytes as number) ?? 0) - bytes) }, { merge: true });
    }).catch(() => {});
    if (err instanceof FieldServicesError) throw err;
    console.error("[field-photos] save failed", err);
    throw new FieldServicesError("Couldn't save the photo. Try again.", 502);
  }

  await recordFieldActivity(visit.contactId, "field_visit", `Photo added (${label}) on ${job.number}.`, {
    jobId: job.id,
    visitId: visit.id,
    photoId: id,
  });
  return { photo: ref };
}

export async function signedPhotoUrl(input: {
  subAccountId: string;
  visitId: string;
  photoId: string;
  thumb: boolean;
}): Promise<string> {
  const visit = await loadVisit(input.subAccountId, input.visitId);
  const photo = (visit.photos ?? []).find((p) => p.id === input.photoId);
  if (!photo) throw new FieldServicesError("Photo not found.", 404);
  const path = input.thumb && photo.thumbPath ? photo.thumbPath : photo.path;
  const [url] = await bucket().file(path).getSignedUrl({
    action: "read",
    expires: Date.now() + 10 * 60_000,
  });
  return url;
}

/** Removes every stored photo of these visits and gives the space back. */
export async function purgeVisitPhotos(subAccountId: string, visits: Visit[]): Promise<void> {
  let freed = 0;
  for (const v of visits) {
    for (const p of v.photos ?? []) {
      for (const path of [p.path, p.thumbPath]) {
        if (!path) continue;
        try {
          const f = bucket().file(path);
          const [meta] = await f.getMetadata();
          freed += Number(meta.size ?? 0);
          await f.delete();
        } catch {
          // Already gone.
        }
      }
    }
  }
  if (freed > 0) {
    const ref = getAdminDb().doc(`subAccounts/${subAccountId}/counters/fieldStorage`);
    await getAdminDb()
      .runTransaction(async (tx) => {
        const used = ((await tx.get(ref)).data()?.bytes as number | undefined) ?? 0;
        tx.set(ref, { bytes: Math.max(0, used - freed) }, { merge: true });
      })
      .catch(() => {});
  }
}

export async function deleteVisitPhoto(input: {
  subAccountId: string;
  visitId: string;
  photoId: string;
  actor: FieldActor;
}): Promise<void> {
  const db = getAdminDb();
  const visit = await loadVisit(input.subAccountId, input.visitId);
  const photo = (visit.photos ?? []).find((p) => p.id === input.photoId);
  if (!photo) throw new FieldServicesError("Photo not found.", 404);
  if (!input.actor.isOffice) {
    assertCanActOnVisit(input.actor, visit);
    const mine = photo.byWorkerId !== null && photo.byWorkerId === input.actor.workerId;
    if (!mine || Date.now() - photo.takenAt > WORKER_DELETE_WINDOW_MS) {
      throw new FieldServicesError("Only the office can delete this photo now.", 403);
    }
  }
  const visitRef = db.doc(`visits/${visit.id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(visitRef);
    const photos = ((snap.data()?.photos as PhotoRef[] | undefined) ?? []).filter((p) => p.id !== input.photoId);
    tx.update(visitRef, { photos, updatedAt: FieldValue.serverTimestamp() });
  });

  let freed = 0;
  for (const p of [photo.path, photo.thumbPath]) {
    if (!p) continue;
    try {
      const f = bucket().file(p);
      const [meta] = await f.getMetadata();
      freed += Number(meta.size ?? 0);
      await f.delete();
    } catch {
    }
  }
  if (freed > 0) {
    await db
      .doc(`subAccounts/${input.subAccountId}/counters/fieldStorage`)
      .set({ bytes: FieldValue.increment(-freed) }, { merge: true })
      .catch(() => {});
  }
  await recordFieldActivity(visit.contactId, "field_visit", `Photo removed from ${visit.jobNumber}.`, {
    jobId: visit.jobId,
    visitId: visit.id,
  });
}
