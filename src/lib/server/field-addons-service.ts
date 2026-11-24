import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import type { FieldAddOn } from "@/types/field-services";

const MAX_ADD_ONS = 50;
const MAX_PRICE_MINOR = 100_000_000;
const MAX_EXTRA_MINUTES = 480;

function serialize(id: string, data: Record<string, unknown>): FieldAddOn {
  return { id, ...data } as FieldAddOn;
}

export async function listAddOns(subAccountId: string): Promise<FieldAddOn[]> {
  const snap = await getAdminDb().collection("fieldAddOns").where("subAccountId", "==", subAccountId).get();
  return snap.docs
    .map((d) => serialize(d.id, d.data()))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

async function loadAddOn(subAccountId: string, addOnId: string): Promise<FieldAddOn> {
  const snap = await getAdminDb().doc(`fieldAddOns/${addOnId}`).get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Add-on not found.", 404);
  }
  return serialize(snap.id, snap.data() ?? {});
}

/** Only services of this workspace may be attached. */
async function cleanServiceIds(subAccountId: string, v: unknown): Promise<string[]> {
  if (!Array.isArray(v)) throw new FieldServicesError("Choose which services it goes with.");
  const ids = [...new Set(v.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x)))].slice(0, 100);
  if (ids.length === 0) return [];
  const db = getAdminDb();
  const docs = await db.getAll(...ids.map((id) => db.doc(`products/${id}`)));
  return docs
    .filter((d) => d.exists && d.data()?.subAccountId === subAccountId && d.data()?.kind === "service")
    .map((d) => d.id);
}

function cleanName(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

function cleanPrice(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_PRICE_MINOR) {
    throw new FieldServicesError("Enter a valid price.");
  }
  return Math.round(v);
}

function cleanMinutes(v: unknown): number {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_EXTRA_MINUTES) {
    throw new FieldServicesError(`Extra time must be between 0 and ${MAX_EXTRA_MINUTES} minutes.`);
  }
  return Math.round(v);
}

export async function createAddOn(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  body: Record<string, unknown>;
}): Promise<{ id: string }> {
  const name = cleanName(input.body.name);
  if (!name) throw new FieldServicesError("Give the add-on a name.");
  const db = getAdminDb();
  const existing = await db.collection("fieldAddOns").where("subAccountId", "==", input.subAccountId).get();
  if (existing.size >= MAX_ADD_ONS) throw new FieldServicesError(`You can have up to ${MAX_ADD_ONS} add-ons.`);
  const ref = db.collection("fieldAddOns").doc();
  const doc: Omit<FieldAddOn, "id"> = {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    name,
    priceMinor: cleanPrice(input.body.priceMinor ?? 0),
    extraMinutes: cleanMinutes(input.body.extraMinutes),
    allServices: input.body.allServices === true,
    serviceIds: await cleanServiceIds(input.subAccountId, input.body.serviceIds ?? []),
    active: input.body.active !== false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);
  return { id: ref.id };
}

export async function updateAddOn(input: {
  subAccountId: string;
  addOnId: string;
  body: Record<string, unknown>;
}): Promise<void> {
  await loadAddOn(input.subAccountId, input.addOnId);
  const updates: Record<string, unknown> = {};
  if (input.body.name !== undefined) {
    const name = cleanName(input.body.name);
    if (!name) throw new FieldServicesError("The name can't be empty.");
    updates.name = name;
  }
  if (input.body.priceMinor !== undefined) updates.priceMinor = cleanPrice(input.body.priceMinor);
  if (input.body.extraMinutes !== undefined) updates.extraMinutes = cleanMinutes(input.body.extraMinutes);
  if (input.body.serviceIds !== undefined) updates.serviceIds = await cleanServiceIds(input.subAccountId, input.body.serviceIds);
  if (typeof input.body.allServices === "boolean") updates.allServices = input.body.allServices;
  if (typeof input.body.active === "boolean") updates.active = input.body.active;
  if (Object.keys(updates).length === 0) throw new FieldServicesError("Nothing to update.");
  updates.updatedAt = FieldValue.serverTimestamp();
  await getAdminDb().doc(`fieldAddOns/${input.addOnId}`).update(updates);
}

/** Past bookings keep their own add-on lines, so removing one only takes it off the page. */
export async function deleteAddOn(subAccountId: string, addOnId: string): Promise<void> {
  await loadAddOn(subAccountId, addOnId);
  await getAdminDb().doc(`fieldAddOns/${addOnId}`).delete();
}

/** Ticking an add-on on a service attaches it. Used by the service dialog. */
export async function setServiceAddOns(input: {
  subAccountId: string;
  serviceId: string;
  addOnIds: string[];
}): Promise<void> {
  const db = getAdminDb();
  const service = await db.doc(`products/${input.serviceId}`).get();
  if (!service.exists || service.data()?.subAccountId !== input.subAccountId || service.data()?.kind !== "service") {
    throw new FieldServicesError("Service not found.", 404);
  }
  const all = await listAddOns(input.subAccountId);
  const wanted = new Set(input.addOnIds);
  const batch = db.batch();
  let changed = 0;
  for (const a of all) {
    const has = a.serviceIds.includes(input.serviceId);
    // An add-on for every service is not narrowed by a tick on one service.
    if (a.allServices) continue;
    if (wanted.has(a.id) && !has) {
      batch.update(db.doc(`fieldAddOns/${a.id}`), { serviceIds: FieldValue.arrayUnion(input.serviceId), updatedAt: FieldValue.serverTimestamp() });
      changed++;
    } else if (!wanted.has(a.id) && has) {
      batch.update(db.doc(`fieldAddOns/${a.id}`), { serviceIds: FieldValue.arrayRemove(input.serviceId), updatedAt: FieldValue.serverTimestamp() });
      changed++;
    }
  }
  if (changed > 0) await batch.commit();
}

/** The active add-ons a customer may tick for the services chosen. */
export async function loadBookableAddOns(subAccountId: string, serviceIds: string[]): Promise<FieldAddOn[]> {
  const all = await listAddOns(subAccountId);
  return all.filter((a) => a.active && (a.allServices || a.serviceIds.some((id) => serviceIds.includes(id))));
}
