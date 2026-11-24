import "server-only";
import { formatServiceAddress, sanitizeServiceAddress } from "@/lib/field-services/address";
import { geocode, geocodingConfigured } from "@/lib/server/geocode";
import { isDayKey } from "@/lib/field-services/intervals";
import { addDaysToKey, zonedDateKey } from "@/lib/field-services/time";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { DEFAULT_WEEKLY_HOURS, cleanTimeOff, cleanWeeklyHours } from "@/lib/field-services/working-hours";
import { loadRateCard, requireTimesheetsOn } from "@/lib/server/field-rate-cards-service";
import { stopRunningTimersForWorker } from "@/lib/server/field-time-service";
import {
  countUpcomingForWorker,
  reassignWorkerVisits,
} from "@/lib/server/field-visits-service";
import {
  MAX_FIELD_WORKERS,
  type FieldWorker,
  type FieldWorkerKind,
} from "@/types/field-services";

const COLORS = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#9333ea",
  "#0891b2",
  "#db2777",
  "#ca8a04",
  "#475569",
];

const KINDS: FieldWorkerKind[] = ["owner", "employee", "contractor"];

export interface WorkerInput {
  memberUid?: string;
  name?: string;
  kind?: string;
  phone?: string;
  email?: string;
  color?: string;
  canHandlePrices?: boolean;
  canSeeCustomerContact?: boolean;
  rateCardId?: string | null;
  crewAccess?: boolean;
  timeOff?: unknown;
  workingHours?: unknown;
  maxVisitsPerDay?: unknown;
  homeBase?: unknown;
  serviceIds?: unknown;
  areaIds?: unknown;
}

function cleanIds(raw: unknown, what: string): string[] {
  if (!Array.isArray(raw) || raw.length > 200 || raw.some((i) => typeof i !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(i))) {
    throw new FieldServicesError(`Choose ${what} from the list.`);
  }
  return [...new Set(raw as string[])];
}

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

function validColor(s: unknown): string | null {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s) ? s : null;
}

async function resolveMember(
  agencyId: string,
  subAccountId: string,
  memberUid: string,
  callerIsAgencyOwner: boolean,
): Promise<{ name: string; email: string }> {
  const db = getAdminDb();
  const [agencySnap, memberSnap] = await Promise.all([
    db.doc(`agencies/${agencyId}`).get(),
    db.doc(`subAccounts/${subAccountId}/subAccountMembers/${memberUid}`).get(),
  ]);
  const isOwner = agencySnap.data()?.ownerUid === memberUid;
  // Only the agency owner can add themselves.
  if (isOwner && !callerIsAgencyOwner) {
    throw new FieldServicesError(
      "Only the agency owner can add themselves as a worker.",
      403,
    );
  }
  const member = memberSnap.exists ? memberSnap.data() : null;
  if (!isOwner && member?.status !== "active") {
    throw new FieldServicesError(
      "That person isn't an active member of this workspace.",
    );
  }
  let name = (member?.displayName as string | undefined) ?? "";
  let email = (member?.email as string | undefined) ?? "";
  if (!name || !email) {
    const user = (await db.doc(`users/${memberUid}`).get()).data();
    name = name || (user?.displayName as string | undefined) || "";
    email = email || (user?.email as string | undefined) || "";
  }
  return { name: name || email || "Worker", email };
}

export async function createFieldWorker(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  callerIsAgencyOwner: boolean;
  body: WorkerInput;
  /** A fixed id, so two requests creating the same person cannot both succeed. */
  docId?: string;
}): Promise<{ id: string }> {
  const { agencyId, subAccountId, createdByUid, callerIsAgencyOwner, body } =
    input;
  const memberUid = clean(body.memberUid, 128);
  if (!memberUid) throw new FieldServicesError("Choose a workspace member.");

  const db = getAdminDb();
  const existing = await db
    .collection("fieldWorkers")
    .where("subAccountId", "==", subAccountId)
    .get();
  if (existing.size >= MAX_FIELD_WORKERS) {
    throw new FieldServicesError(
      `A workspace can have at most ${MAX_FIELD_WORKERS} worker profiles.`,
    );
  }
  const dup = existing.docs.find((d) => d.data().memberUid === memberUid);
  if (dup) {
    if (dup.data().status === "removed") {
      throw new FieldServicesError(
        "This person has a removed worker profile. Restore it instead.",
        409,
      );
    }
    throw new FieldServicesError("This person already has a worker profile.", 409);
  }

  const member = await resolveMember(
    agencyId,
    subAccountId,
    memberUid,
    callerIsAgencyOwner,
  );
  const kind = KINDS.includes(body.kind as FieldWorkerKind)
    ? (body.kind as FieldWorkerKind)
    : "employee";
  const email = (clean(body.email, 200) || member.email).toLowerCase();
  const sameEmail = email
    ? existing.docs.find(
        (d) =>
          !d.data().memberUid &&
          d.data().status === "active" &&
          String(d.data().email ?? "").toLowerCase() === email,
      )
    : undefined;
  if (sameEmail) {
    // The same person already works here as crew. They keep that record rather than getting a second one.
    await sameEmail.ref.update({ memberUid, updatedAt: FieldValue.serverTimestamp() });
    return { id: sameEmail.id };
  }

  let workingHours = DEFAULT_WEEKLY_HOURS;
  if (body.workingHours !== undefined) {
    const h = cleanWeeklyHours(body.workingHours);
    if (typeof h === "string") throw new FieldServicesError(h);
    workingHours = h;
  }
  const ref = input.docId ? db.collection("fieldWorkers").doc(input.docId) : db.collection("fieldWorkers").doc();
  const doc: Omit<FieldWorker, "id"> = {
    agencyId,
    subAccountId,
    createdByUid,
    memberUid,
    name: clean(body.name, 120) || member.name,
    kind,
    phone: clean(body.phone, 40),
    email,
    crewAccess: true,
    color: validColor(body.color) ?? COLORS[existing.size % COLORS.length],
    status: "active",
    canHandlePrices: body.canHandlePrices === true,
    canSeeCustomerContact: body.canSeeCustomerContact !== false,
    workingHours,
    serviceIds: body.serviceIds !== undefined ? cleanIds(body.serviceIds, "the services") : [],
    areaIds: body.areaIds !== undefined ? cleanIds(body.areaIds, "the areas") : [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (input.docId) await ref.create(doc);
  else await ref.set(doc);
  return { id: ref.id };
}

/** Retires the profile and unassigns their unfinished visits. */
export async function retireWorkerForMember(subAccountId: string, memberUid: string): Promise<void> {
  const snap = await getAdminDb()
    .collection("fieldWorkers")
    .where("subAccountId", "==", subAccountId)
    .where("memberUid", "==", memberUid)
    .get();
  for (const d of snap.docs) {
    if (d.data().status !== "active") continue;
    await reassignWorkerVisits({ subAccountId, fromWorkerId: d.id, toWorkerId: null });
    await d.ref.update({ status: "removed", updatedAt: FieldValue.serverTimestamp() });
    await stopRunningTimersForWorker(subAccountId, d.id).catch(() => {});
  }
}

async function loadWorker(subAccountId: string, workerId: string) {
  const ref = getAdminDb().doc(`fieldWorkers/${workerId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Worker not found.", 404);
  }
  return { ref, data: snap.data() as Omit<FieldWorker, "id"> };
}

export async function updateFieldWorker(input: {
  subAccountId: string;
  workerId: string;
  body: WorkerInput & { status?: string; reassignTo?: string };
}): Promise<void> {
  const { subAccountId, workerId, body } = input;
  const { ref, data: current } = await loadWorker(subAccountId, workerId);

  const updates: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const name = clean(body.name, 120);
    if (!name) throw new FieldServicesError("Name can't be empty.");
    updates.name = name;
  }
  if (body.kind !== undefined) {
    if (!KINDS.includes(body.kind as FieldWorkerKind)) {
      throw new FieldServicesError("Unknown worker type.");
    }
    updates.kind = body.kind;
  }
  if (current.memberUid && body.email !== undefined) {
    throw new FieldServicesError("A workspace member's email is their login email. Change it on their member account.", 409);
  }
  if (typeof body.phone === "string") updates.phone = clean(body.phone, 40);
  if (typeof body.email === "string") {
    const nextEmail = clean(body.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) throw new FieldServicesError("Enter a valid email address.");
    updates.email = nextEmail;
    // A different address is a different person, so the old person must not keep this record.
    if (nextEmail !== (current.email ?? "").toLowerCase()) {
      const taken = await getAdminDb()
        .collection("fieldWorkers")
        .where("subAccountId", "==", subAccountId)
        .where("email", "==", nextEmail)
        .get();
      if (taken.docs.some((d) => d.id !== workerId && d.data().status === "active")) {
        throw new FieldServicesError("Someone else on this team already uses that email.", 409);
      }
      updates.personId = FieldValue.delete();
      updates.portalStatus = "none";
      const open = await getAdminDb()
        .collection("fieldInvites")
        .where("workerId", "==", workerId)
        .where("consumedAt", "==", null)
        .get();
      await Promise.all(open.docs.map((d) => d.ref.delete()));
    }
  }
  if (typeof body.crewAccess === "boolean" && body.crewAccess !== (current.crewAccess !== false)) {
    updates.crewAccess = body.crewAccess;
    if (body.crewAccess === false) {
      updates.portalStatus = "revoked";
      const open = await getAdminDb()
        .collection("fieldInvites")
        .where("workerId", "==", workerId)
        .where("consumedAt", "==", null)
        .get();
      await Promise.all(open.docs.map((d) => d.ref.delete()));
    } else if (current.portalStatus === "revoked") {
      updates.portalStatus = "none";
      // Starts again from the email sign-in, including for a person who was linked by an old phone number.
      updates.personId = FieldValue.delete();
    }
  }
  if (body.color !== undefined) {
    const color = validColor(body.color);
    if (!color) throw new FieldServicesError("Colour must look like #2563eb.");
    updates.color = color;
  }
  if (typeof body.canHandlePrices === "boolean") {
    updates.canHandlePrices = body.canHandlePrices;
  }
  if (typeof body.canSeeCustomerContact === "boolean") {
    updates.canSeeCustomerContact = body.canSeeCustomerContact;
  }
  if (body.workingHours !== undefined) {
    const h = cleanWeeklyHours(body.workingHours);
    if (typeof h === "string") throw new FieldServicesError(h);
    updates.workingHours = h;
  }
  if (body.maxVisitsPerDay !== undefined) {
    const n = body.maxVisitsPerDay;
    if (n === null) {
      updates.maxVisitsPerDay = null;
    } else if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 50) {
      updates.maxVisitsPerDay = n;
    } else {
      throw new FieldServicesError("The most visits a day must be a whole number from 1 to 50, or empty for no limit.");
    }
  }
  if (body.timeOff !== undefined) {
    const t = cleanTimeOff(body.timeOff);
    if (typeof t === "string") throw new FieldServicesError(t);
    updates.timeOff = t;
  }
  if (body.homeBase !== undefined) {
    if (body.homeBase === null) throw new FieldServicesError("Where their day starts is required.");
    const a = sanitizeServiceAddress(body.homeBase);
    if (!a || !a.line1) throw new FieldServicesError("Enter the street address for where their day starts.");
    const p = await geocode(formatServiceAddress(a), a.country);
    // With a map service set up, an address it can't find is refused, so routing never works from a guess.
    if (!p && geocodingConfigured()) {
      throw new FieldServicesError("That start address couldn't be found on the map. Check the street, suburb and postcode.");
    }
    updates.homeBase = a;
    updates.homeBasePoint = p ? { lat: p.lat, lng: p.lng } : null;
  }
  if (body.serviceIds !== undefined) updates.serviceIds = cleanIds(body.serviceIds, "the services");
  if (body.areaIds !== undefined) updates.areaIds = cleanIds(body.areaIds, "the areas");
  if (body.rateCardId !== undefined) {
    if (body.rateCardId === null || body.rateCardId === "") {
      updates.rateCardId = null;
    } else if (typeof body.rateCardId === "string") {
      if (body.rateCardId !== current.rateCardId) {
        await requireTimesheetsOn(subAccountId);
        const card = await loadRateCard(subAccountId, body.rateCardId);
        if (card.archived) throw new FieldServicesError("That rate card is archived.");
      }
      updates.rateCardId = body.rateCardId;
    } else {
      throw new FieldServicesError("Choose a rate card.");
    }
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "removed") {
      throw new FieldServicesError("Unknown status.");
    }
    if (body.status === "removed") {
      const upcoming = await countUpcomingForWorker(subAccountId, workerId);
      if (upcoming > 0) {
        const target = body.reassignTo;
        if (target === undefined) {
          throw new FieldServicesError(
            `This worker still has ${upcoming} unfinished visit${upcoming === 1 ? "" : "s"}. Choose who takes them, or leave them unassigned.`,
            409,
          );
        }
        await reassignWorkerVisits({
          subAccountId,
          fromWorkerId: workerId,
          toWorkerId: target === "unassigned" || target === "" ? null : target,
        });
      }
    }
    updates.status = body.status;
    if (body.status === "removed" && !current.memberUid) updates.portalStatus = "revoked";
    if (body.status === "active" && current.status === "removed" && current.portalStatus === "revoked" && !current.memberUid) {
      updates.portalStatus = "none";
      updates.personId = FieldValue.delete();
    }
  }
  if (Object.keys(updates).length === 0) {
    throw new FieldServicesError("Nothing to update.");
  }
  updates.updatedAt = FieldValue.serverTimestamp();
  await ref.update(updates);
  // Reassigning visits can restart a general timer; a removed worker must have none running.
  if (updates.status === "removed" || updates.crewAccess === false) {
    await stopRunningTimersForWorker(subAccountId, workerId).catch(() => {});
  }
}

/**
 * Gives every active workspace member a staff record once. Removed records are left alone and the agency owner is never added.
 */
export async function syncMemberWorkers(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
}): Promise<{ created: number }> {
  const db = getAdminDb();
  const [agencySnap, membersSnap, workersSnap] = await Promise.all([
    db.doc(`agencies/${input.agencyId}`).get(),
    db.collection(`subAccounts/${input.subAccountId}/subAccountMembers`).where("status", "==", "active").get(),
    db.collection("fieldWorkers").where("subAccountId", "==", input.subAccountId).get(),
  ]);
  const ownerUid = agencySnap.data()?.ownerUid as string | undefined;
  const have = new Set(workersSnap.docs.map((d) => d.data().memberUid as string).filter(Boolean));
  let created = 0;
  for (const m of membersSnap.docs) {
    const uid = m.id;
    if (uid === ownerUid || have.has(uid)) continue;
    try {
      await createFieldWorker({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        createdByUid: input.createdByUid,
        callerIsAgencyOwner: false,
        body: { memberUid: uid },
        docId: `m_${input.subAccountId}_${uid}`.slice(0, 120),
      });
      created++;
    } catch {
      // Already created by a parallel request, over the profile cap, or a member who went away: the next visit tries again.
      continue;
    }
  }
  return { created };
}

/** Whether the agency owner has an active staff record in this workspace. */
export async function ownerIsStaff(subAccountId: string, ownerUid: string): Promise<boolean> {
  const snap = await getAdminDb()
    .collection("fieldWorkers")
    .where("subAccountId", "==", subAccountId)
    .where("memberUid", "==", ownerUid)
    .get();
  return snap.docs.some((d) => d.data().status === "active");
}

/** Puts the agency owner on, or takes them off, this workspace's staff. */
export async function setOwnerStaff(input: {
  agencyId: string;
  subAccountId: string;
  ownerUid: string;
  on: boolean;
}): Promise<void> {
  const db = getAdminDb();
  if (!input.on) {
    await retireWorkerForMember(input.subAccountId, input.ownerUid);
    return;
  }
  const snap = await db
    .collection("fieldWorkers")
    .where("subAccountId", "==", input.subAccountId)
    .where("memberUid", "==", input.ownerUid)
    .get();
  const existing = snap.docs[0];
  if (existing) {
    if (existing.data().status !== "active") {
      await existing.ref.update({ status: "active", updatedAt: FieldValue.serverTimestamp() });
    }
    return;
  }
  try {
    await createFieldWorker({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      createdByUid: input.ownerUid,
      callerIsAgencyOwner: true,
      body: { memberUid: input.ownerUid, kind: "owner" },
      docId: `m_${input.subAccountId}_${input.ownerUid}`.slice(0, 120),
    });
  } catch (err) {
    // A double click made the same record first.
    if (!/already exists|ALREADY_EXISTS/i.test(String((err as Error)?.message ?? err))) throw err;
  }
}

const MAX_START_OVERRIDES = 60;

/** Sets, or with a null address clears, where one person's day starts on one date. Old dates are dropped as it goes. */
export async function setWorkerDayStart(input: {
  subAccountId: string;
  workerId: string;
  day: string;
  address: unknown;
}): Promise<void> {
  if (!isDayKey(input.day)) throw new FieldServicesError("Choose a day.");
  const { ref, data } = await loadWorker(input.subAccountId, input.workerId);
  if (data.status !== "active") throw new FieldServicesError("That staff member isn't available.", 404);
  const keepFrom = addDaysToKey(zonedDateKey(new Date(), "UTC"), -3);
  const next = Object.fromEntries(Object.entries(data.startOverrides ?? {}).filter(([k]) => k >= keepFrom));
  if (input.address === null || input.address === undefined) {
    delete next[input.day];
  } else {
    const a = sanitizeServiceAddress(input.address);
    if (!a || !a.line1) throw new FieldServicesError("Enter the street address for where the day starts.");
    const p = await geocode(formatServiceAddress(a), a.country);
    if (!p && geocodingConfigured()) {
      throw new FieldServicesError("That address couldn't be found on the map. Check the street, suburb and postcode.");
    }
    if (!(input.day in next) && Object.keys(next).length >= MAX_START_OVERRIDES) {
      throw new FieldServicesError("Too many different starts are set. Clear some old ones first.");
    }
    next[input.day] = { address: a, point: p ? { lat: p.lat, lng: p.lng } : null };
  }
  await ref.update({ startOverrides: next, updatedAt: FieldValue.serverTimestamp() });
}
