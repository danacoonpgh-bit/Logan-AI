import { enqueuePhoto, listQueued, markFailed, removeQueued } from "@/lib/field-services/photo-queue";

export async function sendPhoto(input: {
  subAccountId: string;
  visitId: string;
  photo: Blob;
  thumb: Blob;
  label: string;
  note: string;
  uid?: string;
}): Promise<{ ok: true } | { ok: false; error: string; retryable: boolean }> {
  const portal = input.uid?.startsWith("fp_") === true;
  const url = portal
    ? `/api/field-portal/${input.subAccountId}/visits/${input.visitId}/photos`
    : `/api/sub-accounts/${input.subAccountId}/field-services/visits/${input.visitId}/photos`;
  const form = new FormData();
  form.set("photo", input.photo, "photo.jpg");
  form.set("thumb", input.thumb, "thumb.jpg");
  form.set("label", input.label);
  form.set("note", input.note);
  try {
    const res = await fetch(url, { method: "POST", body: form });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      error: data.error ?? "Upload failed.",
      retryable: res.status >= 500 || res.status === 429,
    };
  } catch {
    return { ok: false, error: "No connection.", retryable: true };
  }
}

export async function uploadOrQueue(input: {
  subAccountId: string;
  visitId: string;
  photo: Blob;
  thumb: Blob;
  label: string;
  note: string;
  uid: string;
}): Promise<"uploaded" | "queued" | { error: string }> {
  const res = await sendPhoto(input);
  if (res.ok) return "uploaded";
  if (res.retryable && (await enqueuePhoto(input))) return "queued";
  return { error: res.error };
}

let flushing = false;

export async function flushQueue(uid: string): Promise<number> {
  // Overlapping runs would upload the same photo twice.
  if (flushing) return 0;
  flushing = true;
  try {
    return await flushOnce(uid);
  } finally {
    flushing = false;
  }
}

async function flushOnce(uid: string): Promise<number> {
  let sent = 0;
  for (const q of await listQueued()) {
    if (q.uid !== uid || q.lastError) continue;
    const res = await sendPhoto(q);
    if (res.ok) {
      await removeQueued(q.id);
      sent++;
    } else if (!res.retryable) {
      await markFailed(q.id, res.error);
    }
  }
  return sent;
}
