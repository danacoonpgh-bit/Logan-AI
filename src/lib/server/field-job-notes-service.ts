import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { type FieldActor } from "@/lib/server/field-access";
import { runAfterResponse } from "@/lib/server/after-response";
import { notifyCrewOfJobChange } from "@/lib/server/field-crew-notify-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import type { Job, JobNote } from "@/types/field-services";

const MAX_NOTES = 100;
const MAX_LENGTH = 2_000;
const NOTE_ID = /^[A-Za-z0-9_-]{6,40}$/;

function cleanText(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").trim() : "";
  if (!text) throw new FieldServicesError("Write the note first.");
  return text.slice(0, MAX_LENGTH);
}

async function authorName(subAccountId: string, actor: FieldActor): Promise<string> {
  const db = getAdminDb();
  if (actor.workerId) {
    const worker = (await db.doc(`fieldWorkers/${actor.workerId}`).get()).data();
    if (worker?.subAccountId === subAccountId && typeof worker.name === "string" && worker.name) return worker.name;
  }
  const user = (await db.doc(`users/${actor.uid}`).get()).data();
  return typeof user?.displayName === "string" && user.displayName ? user.displayName : "Office";
}

/** A note on a project: anyone who can see the project adds one; the office changes any, crew only their own. */
export async function changeJobNote(input: {
  subAccountId: string;
  jobId: string;
  actor: FieldActor;
  action: "add" | "edit" | "delete";
  noteId?: string;
  text?: unknown;
}): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`jobs/${input.jobId}`);
  const text = input.action === "delete" ? "" : cleanText(input.text);
  const name = input.action === "add" ? await authorName(input.subAccountId, input.actor) : "";
  const now = Date.now();
  let textChanged = true;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const job = snap.data() as Job | undefined;
    if (!job || job.subAccountId !== input.subAccountId) throw new FieldServicesError("Not found.", 404);
    if (job.status === "cancelled") throw new FieldServicesError("A cancelled project can't be changed.", 409);
    const notes = [...(job.notes ?? [])];

    if (input.action === "add") {
      if (notes.length >= MAX_NOTES) throw new FieldServicesError("This project has the most notes it can hold.", 409);
      notes.push({
        id: db.collection("jobs").doc().id,
        text,
        byName: name,
        byWorkerId: input.actor.workerId,
        byUid: input.actor.isOffice ? input.actor.uid : null,
        createdAtMs: now,
      });
    } else {
      if (!input.noteId || !NOTE_ID.test(input.noteId)) throw new FieldServicesError("Note not found.", 404);
      const at = notes.findIndex((n) => n.id === input.noteId);
      if (at === -1) throw new FieldServicesError("Note not found.", 404);
      const note = notes[at];
      const mine = !input.actor.isOffice && input.actor.workerId !== null && note.byWorkerId === input.actor.workerId;
      if (!input.actor.isOffice && !mine) throw new FieldServicesError("You can only change your own notes.", 403);
      if (input.action === "delete") notes.splice(at, 1);
      else {
        textChanged = note.text !== text;
        notes[at] = { ...note, text, editedAtMs: now };
      }
    }
    tx.update(ref, { notes, updatedAt: FieldValue.serverTimestamp() });
  });

  // Crew writing their own note do not need an alert; the office adding or changing one does.
  if (input.actor.isOffice && input.action !== "delete" && textChanged) {
    const detail = input.action === "add" ? "New note from the office" : "Note changed";
    // An admin who is also on the crew does not alert themselves.
    runAfterResponse(() => notifyCrewOfJobChange({ jobId: input.jobId, detail, exceptWorkerId: input.actor.workerId }));
  }
}

/** What a worker sees: the notes with a flag for the ones they wrote. */
export function notesForWorker(notes: JobNote[] | undefined, workerId: string) {
  return (notes ?? []).map((n) => ({
    id: n.id,
    text: n.text,
    byName: n.byName,
    createdAtMs: n.createdAtMs,
    editedAtMs: n.editedAtMs ?? null,
    mine: n.byWorkerId === workerId,
  }));
}
