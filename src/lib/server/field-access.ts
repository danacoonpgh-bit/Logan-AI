import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import type { Visit } from "@/types/field-services";

export interface FieldActor {
  uid: string;
  isOffice: boolean;
  workerId: string | null;
}

export async function workerForUid(subAccountId: string, uid: string): Promise<string | null> {
  const snap = await getAdminDb()
    .collection("fieldWorkers")
    .where("subAccountId", "==", subAccountId)
    .where("memberUid", "==", uid)
    .get();
  const active = snap.docs.find((d) => d.data().status === "active");
  return active?.id ?? null;
}

/** Whether this member once had a staff record that is now switched off. They are not treated as office. */
async function staffRetired(subAccountId: string, uid: string): Promise<boolean> {
  const snap = await getAdminDb()
    .collection("fieldWorkers")
    .where("subAccountId", "==", subAccountId)
    .where("memberUid", "==", uid)
    .get();
  return snap.docs.length > 0 && !snap.docs.some((d) => d.data().status === "active");
}

export async function actorIsOffice(
  subAccountId: string,
  uid: string,
  role: string,
): Promise<boolean> {
  if (role === "admin" || role === "agencyOwner") return true;
  if ((await workerForUid(subAccountId, uid)) !== null) return false;
  return !(await staffRetired(subAccountId, uid));
}

export async function resolveActor(
  subAccountId: string,
  uid: string,
  role: string,
): Promise<FieldActor> {
  const workerId = await workerForUid(subAccountId, uid);
  const isOffice =
    role === "admin" || role === "agencyOwner" || (workerId === null && !(await staffRetired(subAccountId, uid)));
  return { uid, isOffice, workerId };
}

export function assertCanActOnVisit(actor: FieldActor, visit: Pick<Visit, "workerIds">): void {
  if (actor.isOffice) return;
  if (!actor.workerId || !visit.workerIds.includes(actor.workerId)) {
    throw new FieldServicesError("You can only update visits you are assigned to.", 403);
  }
}
