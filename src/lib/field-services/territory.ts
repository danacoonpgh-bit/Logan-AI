import "server-only";

import { NextResponse } from "next/server";
import { territoryGate } from "@/lib/auth/territory-filter";
import { getAdminDb } from "@/lib/firebase/admin";
import type { FieldServicesAccess } from "@/lib/field-services/gate";

export async function requireTerritoryOfContact(
  guard: FieldServicesAccess,
  contactId: string,
): Promise<NextResponse | null> {
  const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
  if (!snap.exists || snap.data()?.subAccountId !== guard.access.subAccountId) {
    return NextResponse.json({ error: "Contact not found." }, { status: 404 });
  }
  return territoryGate(
    guard.access,
    (snap.data()?.territoryId as string | null | undefined) ?? null,
  );
}

export async function requireTerritoryOfDoc(
  guard: FieldServicesAccess,
  collection:
    | "serviceRequests"
    | "jobs"
    | "visits"
    | "timeEntries"
    | "materialLines"
    | "jobPayments",
  id: string,
  workerId: string | null = null,
): Promise<NextResponse | null> {
  if (id.includes("/")) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const snap = await getAdminDb().doc(`${collection}/${id}`).get();
  if (!snap.exists || snap.data()?.subAccountId !== guard.access.subAccountId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // A worker acts on their own assigned work whatever its territory.
  const d = snap.data();
  if (workerId && (d?.workerId === workerId || (d?.workerIds as string[] | undefined)?.includes(workerId))) {
    return null;
  }
  return territoryGate(
    guard.access,
    (snap.data()?.territoryId as string | null | undefined) ?? null,
  );
}
