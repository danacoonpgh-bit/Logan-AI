import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { parseIdentity } from "@/lib/field-portal/identity";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { createPortalWorker, type InviteResult } from "@/lib/server/field-portal-invite-service";
import { loadRateCard, requireTimesheetsOn } from "@/lib/server/field-rate-cards-service";
import type { FieldWorkerKind } from "@/types/field-services";

const MAX_SERVICE_MEMBERS = 200;

export interface ServiceMember {
  id: string;
  name: string;
  /** Normalised mobile number or email the crew app invite goes to. */
  identifier: string;
  classification: string;
  rateCardId: string | null;
  workerId: string | null;
  status: "active" | "removed";
}

export interface ServiceMemberRow extends ServiceMember {
  /** Whether they currently hold an active Field Services worker profile. */
  inFieldServices: boolean;
  portalStatus: string | null;
}

function memberDocId(subAccountId: string, identifier: string): string {
  return createHash("sha256").update(`${subAccountId}|${identifier}`).digest("hex").slice(0, 32);
}

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

async function checkRateCard(subAccountId: string, rateCardId: unknown): Promise<string | null> {
  if (rateCardId === undefined || rateCardId === null || rateCardId === "") return null;
  if (typeof rateCardId !== "string") throw new FieldServicesError("Choose a rate card.");
  await requireTimesheetsOn(subAccountId);
  const card = await loadRateCard(subAccountId, rateCardId);
  if (card.archived) throw new FieldServicesError("That rate card is archived.");
  return rateCardId;
}

async function load(subAccountId: string, memberId: string) {
  const ref = getAdminDb().doc(`fieldServiceMembers/${memberId}`);
  const snap = await ref.get();
  const data = snap.data();
  if (!snap.exists || !data || data.subAccountId !== subAccountId || data.status === "removed") {
    throw new FieldServicesError("Service member not found.", 404);
  }
  return { ref, data };
}

async function activeWorker(workerId: string | null | undefined) {
  if (!workerId) return null;
  const w = (await getAdminDb().doc(`fieldWorkers/${workerId}`).get()).data();
  return w && w.status === "active" ? w : null;
}

export async function listServiceMembers(subAccountId: string): Promise<ServiceMemberRow[]> {
  const db = getAdminDb();
  const snap = await db.collection("fieldServiceMembers").where("subAccountId", "==", subAccountId).get();
  const rows: ServiceMemberRow[] = [];
  for (const d of snap.docs) {
    const m = d.data();
    if (m.status === "removed") continue;
    const w = await activeWorker(m.workerId as string | null);
    rows.push({
      id: d.id,
      name: m.name as string,
      identifier: m.identifier as string,
      classification: (m.classification as string) ?? "",
      rateCardId: (m.rateCardId as string | null) ?? null,
      workerId: w ? (m.workerId as string) : null,
      status: "active",
      inFieldServices: w !== null,
      portalStatus: (w?.portalStatus as string | undefined) ?? null,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createServiceMember(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  body: Record<string, unknown>;
}): Promise<{ id: string }> {
  const { subAccountId, body } = input;
  const name = clean(body.name, 120);
  if (!name) throw new FieldServicesError("Enter the person's name.");
  const identity = parseIdentity(body.identifier);
  if (!identity || identity.kind !== "email") throw new FieldServicesError("Enter a valid email address.");
  const rateCardId = await checkRateCard(subAccountId, body.rateCardId);

  const db = getAdminDb();
  const existing = await db.collection("fieldServiceMembers").where("subAccountId", "==", subAccountId).get();
  const live = existing.docs.filter((d) => d.data().status !== "removed");
  if (live.length >= MAX_SERVICE_MEMBERS) {
    throw new FieldServicesError(`A workspace can have at most ${MAX_SERVICE_MEMBERS} service members.`);
  }
  const ref = db.doc(`fieldServiceMembers/${memberDocId(subAccountId, identity.value)}`);
  await db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (cur && cur.status !== "removed") {
      throw new FieldServicesError("A service member with that number or email already exists.", 409);
    }
    tx.set(ref, {
      agencyId: input.agencyId,
      subAccountId,
      createdByUid: input.createdByUid,
      name,
      identifier: identity.value,
      phone: clean(body.phone, 40),
      classification: clean(body.classification, 80),
      rateCardId,
      workerId: null,
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { id: ref.id };
}

export async function updateServiceMember(input: {
  subAccountId: string;
  memberId: string;
  body: Record<string, unknown>;
}): Promise<void> {
  const { subAccountId, memberId, body } = input;
  const { ref, data } = await load(subAccountId, memberId);
  const inField = (await activeWorker(data.workerId as string | null)) !== null;
  const updates: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const name = clean(body.name, 120);
    if (!name) throw new FieldServicesError("Name can't be empty.");
    updates.name = name;
  }
  if (typeof body.classification === "string") updates.classification = clean(body.classification, 80);
  if (body.rateCardId !== undefined) updates.rateCardId = await checkRateCard(subAccountId, body.rateCardId);
  if (body.identifier !== undefined) {
    throw new FieldServicesError(
      "A number or email can't be changed. Remove this service member and add them again.",
      409,
    );
  }
  if (Object.keys(updates).length === 0) throw new FieldServicesError("Nothing to update.");
  await ref.update({ ...updates, updatedAt: FieldValue.serverTimestamp() });
  // Keep the live worker's rate card in step with the classification.
  if (inField && "rateCardId" in updates && data.workerId) {
    await getAdminDb()
      .doc(`fieldWorkers/${data.workerId}`)
      .update({ rateCardId: updates.rateCardId, updatedAt: FieldValue.serverTimestamp() });
  }
}

export async function removeServiceMember(input: { subAccountId: string; memberId: string }): Promise<void> {
  const { ref, data } = await load(input.subAccountId, input.memberId);
  if (await activeWorker(data.workerId as string | null)) {
    throw new FieldServicesError(
      "They are still a Field Services worker. Remove them on the Workers tab first.",
      409,
    );
  }
  await ref.update({ status: "removed", updatedAt: FieldValue.serverTimestamp() });
}

/** Makes the service member a schedulable crew worker and sends the crew app invite. */
export async function addServiceMemberToFieldServices(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  memberId: string;
  body: Record<string, unknown>;
}): Promise<InviteResult> {
  const { subAccountId, memberId, body } = input;
  const { ref, data } = await load(subAccountId, memberId);
  if (await activeWorker(data.workerId as string | null)) {
    throw new FieldServicesError("They are already in Field Services.", 409);
  }
  if (!parseIdentity(data.identifier) || parseIdentity(data.identifier)?.kind !== "email") {
    throw new FieldServicesError("This person was added with a mobile number. The crew app now signs in by email: remove them and add them again with an email.", 409);
  }
  // Short claim so a double click cannot create two workers for one person.
  await getAdminDb().runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    const at = (cur?.addingAt as number | undefined) ?? 0;
    if (Date.now() - at < 30_000) {
      throw new FieldServicesError("Already being added. Give it a moment.", 409);
    }
    tx.update(ref, { addingAt: Date.now() });
  });
  const result = await createPortalWorker({
    agencyId: input.agencyId,
    subAccountId,
    createdByUid: input.createdByUid,
    body: {
      name: data.name as string,
      identifier: data.identifier as string,
      phone: (data.phone as string | undefined) ?? "",
      kind: clean(body.kind, 20) as FieldWorkerKind,
      canHandlePrices: body.canHandlePrices === true,
      canSeeCustomerContact: body.canSeeCustomerContact !== false,
    },
  });
  const workerUpdates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  const rateCardId = (data.rateCardId as string | null) ?? null;
  if (rateCardId) {
    try {
      await requireTimesheetsOn(subAccountId);
      const card = await loadRateCard(subAccountId, rateCardId);
      if (!card.archived) workerUpdates.rateCardId = rateCardId;
    } catch {
      // Timesheets are off or the card is gone, so the classification stays a label only.
    }
  }
  // One batch so a failure cannot leave a live worker that the member is not linked to.
  const batch = getAdminDb().batch();
  batch.update(getAdminDb().doc(`fieldWorkers/${result.workerId}`), workerUpdates);
  batch.update(ref, { workerId: result.workerId, updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return result;
}
