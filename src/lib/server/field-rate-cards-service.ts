import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { forcedCurrency } from "@/lib/server/field-currency-service";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import type { RateCard } from "@/types/field-services";

const MAX_RATE_CARDS = 50;
const MAX_RATE_MINOR = 100_000_000;

export async function requireTimesheetsOn(subAccountId: string): Promise<void> {
  const config = await getFieldServicesConfig(subAccountId);
  if (!config.timesheetsEnabled) {
    throw new FieldServicesError("Timesheets are switched off for this workspace.", 409);
  }
}

function serialize(id: string, data: Record<string, unknown>): RateCard {
  return { id, ...data } as RateCard;
}

export async function listRateCards(subAccountId: string): Promise<RateCard[]> {
  const snap = await getAdminDb()
    .collection("fieldRateCards")
    .where("subAccountId", "==", subAccountId)
    .get();
  return snap.docs
    .map((d) => serialize(d.id, d.data()))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
}

export async function loadRateCard(subAccountId: string, cardId: string): Promise<RateCard> {
  const snap = await getAdminDb().doc(`fieldRateCards/${cardId}`).get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Rate card not found.", 404);
  }
  return serialize(snap.id, snap.data() ?? {});
}

function cleanName(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, 80) : "";
}

function cleanRate(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_RATE_MINOR) {
    throw new FieldServicesError(`Enter a valid ${label}.`);
  }
  return Math.round(v);
}

function cleanDayRate(v: unknown): number | null {
  if (v === null || v === undefined || v === 0) return null;
  return cleanRate(v, "day rate");
}

function cleanCurrency(v: unknown): string {
  if (v === undefined || v === null || v === "") return "USD";
  if (typeof v !== "string" || !/^[A-Za-z]{3}$/.test(v.trim())) {
    throw new FieldServicesError("Use a three-letter currency code, like USD or AUD.");
  }
  return v.trim().toUpperCase();
}

export async function createRateCard(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  body: Record<string, unknown>;
}): Promise<{ id: string }> {
  await requireTimesheetsOn(input.subAccountId);
  const name = cleanName(input.body.name);
  if (!name) throw new FieldServicesError("Give the rate card a name, like Electrician.");
  const hourlyRateMinor = cleanRate(input.body.hourlyRateMinor ?? 0, "hourly rate");
  const dayRateMinor = cleanDayRate(input.body.dayRateMinor);
  if (hourlyRateMinor <= 0 && dayRateMinor === null) {
    throw new FieldServicesError("Set an hourly rate, a day rate, or both.");
  }

  const db = getAdminDb();
  const existing = await db
    .collection("fieldRateCards")
    .where("subAccountId", "==", input.subAccountId)
    .get();
  if (existing.size >= MAX_RATE_CARDS) {
    throw new FieldServicesError(`You can have up to ${MAX_RATE_CARDS} rate cards.`);
  }
  const ref = db.collection("fieldRateCards").doc();
  const doc: Omit<RateCard, "id"> = {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    name,
    currency: await forcedCurrency(input.subAccountId, cleanCurrency(input.body.currency)),
    hourlyRateMinor,
    dayRateMinor,
    archived: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);
  return { id: ref.id };
}

/** Edits apply to the next invoice drafted. Invoices already drafted keep the rate they were drafted at. */
export async function updateRateCard(input: {
  subAccountId: string;
  cardId: string;
  body: Record<string, unknown>;
}): Promise<void> {
  await requireTimesheetsOn(input.subAccountId);
  const current = await loadRateCard(input.subAccountId, input.cardId);
  const updates: Record<string, unknown> = {};
  if (input.body.name !== undefined) {
    const name = cleanName(input.body.name);
    if (!name) throw new FieldServicesError("The name can't be empty.");
    updates.name = name;
  }
  if (input.body.currency !== undefined) updates.currency = await forcedCurrency(input.subAccountId, cleanCurrency(input.body.currency));
  if (input.body.hourlyRateMinor !== undefined) {
    updates.hourlyRateMinor = cleanRate(input.body.hourlyRateMinor, "hourly rate");
  }
  if (input.body.dayRateMinor !== undefined) updates.dayRateMinor = cleanDayRate(input.body.dayRateMinor);
  if (typeof input.body.archived === "boolean") updates.archived = input.body.archived;
  if (Object.keys(updates).length === 0) throw new FieldServicesError("Nothing to update.");

  const hourly = (updates.hourlyRateMinor as number | undefined) ?? current.hourlyRateMinor;
  const day =
    updates.dayRateMinor !== undefined ? (updates.dayRateMinor as number | null) : current.dayRateMinor;
  if (hourly <= 0 && day === null) {
    throw new FieldServicesError("Keep an hourly rate, a day rate, or both.");
  }
  updates.updatedAt = FieldValue.serverTimestamp();
  await getAdminDb().doc(`fieldRateCards/${input.cardId}`).update(updates);
}
