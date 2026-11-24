import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getJobTerms } from "@/lib/server/field-services-config-service";
import { requireTimesheetsOn } from "@/lib/server/field-rate-cards-service";
import type { InternalJob } from "@/types/field-services";

const MAX_INTERNAL_JOBS = 30;
const MAX_WORKERS = 200;

function serialize(id: string, data: Record<string, unknown>): InternalJob {
  return { id, ...data } as InternalJob;
}

export async function listInternalJobs(subAccountId: string): Promise<InternalJob[]> {
  const snap = await getAdminDb()
    .collection("fieldInternalJobs")
    .where("subAccountId", "==", subAccountId)
    .get();
  return snap.docs
    .map((d) => serialize(d.id, d.data()))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
}

export async function loadInternalJob(subAccountId: string, id: unknown): Promise<InternalJob> {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) {
    throw new FieldServicesError(`Internal ${(await getJobTerms(subAccountId)).job} not found.`, 404);
  }
  const snap = await getAdminDb().doc(`fieldInternalJobs/${id}`).get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError(`Internal ${(await getJobTerms(subAccountId)).job} not found.`, 404);
  }
  return serialize(snap.id, snap.data() ?? {});
}

export function workerMayUseInternalJob(job: InternalJob, workerId: string): boolean {
  return !job.archived && (job.allCrew === true || job.workerIds.includes(workerId));
}

function cleanName(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, 80) : "";
}

/** Keeps only ids of this workspace's workers, so a request can't smuggle in another business's ids. */
export async function validWorkerIds(subAccountId: string, ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids)) throw new FieldServicesError("Choose workers from the list.");
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (wanted.length > MAX_WORKERS) throw new FieldServicesError("That is too many workers.");
  if (wanted.length === 0) return [];
  const snap = await getAdminDb()
    .collection("fieldWorkers")
    .where("subAccountId", "==", subAccountId)
    .get();
  const known = new Set(snap.docs.map((d) => d.id));
  const bad = wanted.filter((id) => !known.has(id));
  if (bad.length > 0) throw new FieldServicesError("One of those workers isn't part of this workspace.");
  return wanted;
}

export async function createInternalJob(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  body: Record<string, unknown>;
}): Promise<{ id: string }> {
  await requireTimesheetsOn(input.subAccountId);
  const name = cleanName(input.body.name);
  if (!name) {
    throw new FieldServicesError(`Give the internal ${(await getJobTerms(input.subAccountId)).job} a name, like Workshop.`);
  }
  const allCrew = input.body.allCrew === true;
  const workerIds = allCrew ? [] : await validWorkerIds(input.subAccountId, input.body.workerIds ?? []);

  const db = getAdminDb();
  const existing = await db
    .collection("fieldInternalJobs")
    .where("subAccountId", "==", input.subAccountId)
    .get();
  if (existing.size >= MAX_INTERNAL_JOBS) {
    throw new FieldServicesError(`You can have up to ${MAX_INTERNAL_JOBS} internal ${(await getJobTerms(input.subAccountId)).jobs}.`);
  }
  const ref = db.collection("fieldInternalJobs").doc();
  const doc: Omit<InternalJob, "id"> = {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    name,
    allCrew,
    workerIds,
    timersEnabled: input.body.timersEnabled === true,
    archived: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);
  return { id: ref.id };
}

export async function updateInternalJob(input: {
  subAccountId: string;
  id: string;
  body: Record<string, unknown>;
}): Promise<void> {
  await requireTimesheetsOn(input.subAccountId);
  await loadInternalJob(input.subAccountId, input.id);
  const updates: Record<string, unknown> = {};
  if (input.body.name !== undefined) {
    const name = cleanName(input.body.name);
    if (!name) throw new FieldServicesError("The name can't be empty.");
    updates.name = name;
  }
  if (typeof input.body.allCrew === "boolean") updates.allCrew = input.body.allCrew;
  if (input.body.workerIds !== undefined) {
    updates.workerIds = await validWorkerIds(input.subAccountId, input.body.workerIds);
  }
  if (typeof input.body.archived === "boolean") updates.archived = input.body.archived;
  if (typeof input.body.timersEnabled === "boolean") updates.timersEnabled = input.body.timersEnabled;
  if (Object.keys(updates).length === 0) throw new FieldServicesError("Nothing to update.");
  updates.updatedAt = FieldValue.serverTimestamp();
  await getAdminDb().doc(`fieldInternalJobs/${input.id}`).update(updates);
}
