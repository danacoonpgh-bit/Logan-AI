import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  assertCanActOnVisit,
  type FieldActor,
} from "@/lib/server/field-access";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getJobTerms } from "@/lib/server/field-services-config-service";
import { existingInvoiceIds } from "@/lib/server/field-invoicing";
import type { Job, MaterialLine, Visit } from "@/types/field-services";

function intMinor(v: unknown, label: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) {
    throw new FieldServicesError(`${label} must be zero or more.`);
  }
  return Math.round(n);
}

async function visitAndJob(subAccountId: string, visitId: string) {
  const db = getAdminDb();
  const vSnap = await db.doc(`visits/${visitId}`).get();
  if (!vSnap.exists || vSnap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Visit not found.", 404);
  }
  const visit = { id: vSnap.id, ...vSnap.data() } as Visit;
  const jSnap = await db.doc(`jobs/${visit.jobId}`).get();
  const job = jSnap.data() as Job | undefined;
  if (!job) throw new FieldServicesError(`${(await getJobTerms(subAccountId)).Job} not found.`, 404);
  if (job.status === "closed" || job.status === "cancelled") {
    throw new FieldServicesError(`This ${(await getJobTerms(subAccountId)).job} is closed.`, 409);
  }
  return { visit, job };
}

export async function addMaterial(input: {
  subAccountId: string;
  visitId: string;
  actor: FieldActor;
  body: Record<string, unknown>;
}): Promise<{ id: string }> {
  const { visit } = await visitAndJob(input.subAccountId, input.visitId);
  assertCanActOnVisit(input.actor, visit);
  const b = input.body;

  const name = typeof b.name === "string" ? b.name.trim().slice(0, 200) : "";
  if (!name) throw new FieldServicesError("Say what the part is.");
  const qty = typeof b.qty === "number" ? b.qty : Number(b.qty);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 100_000) {
    throw new FieldServicesError("Quantity must be more than zero.");
  }
  const notInEstimate = b.notInEstimate === true;
  const workerId = input.actor.workerId ?? visit.workerIds[0] ?? "";

  const ref = getAdminDb().collection("materialLines").doc();
  const doc: Omit<MaterialLine, "id"> = {
    agencyId: visit.agencyId,
    subAccountId: visit.subAccountId,
    territoryId: visit.territoryId,
    jobId: visit.jobId,
    visitId: visit.id,
    workerId,
    catalogItemId: typeof b.catalogItemId === "string" ? b.catalogItemId.slice(0, 128) : null,
    name,
    qty,
    unit: typeof b.unit === "string" && b.unit.trim() ? b.unit.trim().slice(0, 20) : "each",
    unitCostMinor: intMinor(b.unitCostMinor ?? 0, "Cost"),
    unitPriceMinor: intMinor(b.unitPriceMinor ?? 0, "Price"),
    taxable: b.taxable === true,
    source: b.source === "catalog" || b.source === "receipt" ? b.source : "adhoc",
    receiptPhoto: null,
    billable: b.billable !== false,
    notInEstimate,
    approval: notInEstimate ? "pending" : "not_required",
    invoiceLineId: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);
  return { id: ref.id };
}

async function loadLine(subAccountId: string, lineId: string) {
  const ref = getAdminDb().doc(`materialLines/${lineId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Part not found.", 404);
  }
  return { ref, data: { id: snap.id, ...snap.data() } as MaterialLine };
}

async function assertEditable(line: MaterialLine, actor: FieldActor) {
  if (line.invoiceLineId && (await existingInvoiceIds([line.invoiceLineId])).size > 0) {
    throw new FieldServicesError("This part is already on an invoice.", 409);
  }
  if (!actor.isOffice && line.workerId !== actor.workerId) {
    throw new FieldServicesError("You can only change parts you added.", 403);
  }
}

export async function updateMaterial(input: {
  subAccountId: string;
  lineId: string;
  actor: FieldActor;
  body: Record<string, unknown>;
}): Promise<void> {
  const { ref, data } = await loadLine(input.subAccountId, input.lineId);
  await assertEditable(data, input.actor);
  const b = input.body;
  const u: Record<string, unknown> = {};
  if (typeof b.name === "string") {
    const name = b.name.trim().slice(0, 200);
    if (!name) throw new FieldServicesError("Say what the part is.");
    u.name = name;
  }
  if (b.qty !== undefined) {
    const qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100_000) {
      throw new FieldServicesError("Quantity must be more than zero.");
    }
    u.qty = qty;
  }
  if (b.unitCostMinor !== undefined) u.unitCostMinor = intMinor(b.unitCostMinor, "Cost");
  if (b.unitPriceMinor !== undefined) u.unitPriceMinor = intMinor(b.unitPriceMinor, "Price");
  if (typeof b.unit === "string") u.unit = b.unit.trim().slice(0, 20) || "each";
  if (typeof b.taxable === "boolean") u.taxable = b.taxable;
  if (typeof b.billable === "boolean") u.billable = b.billable;
  if (typeof b.notInEstimate === "boolean") {
    u.notInEstimate = b.notInEstimate;
    u.approval = b.notInEstimate ? "pending" : "not_required";
  }
  if (Object.keys(u).length === 0) throw new FieldServicesError("Nothing to change.");
  u.updatedAt = FieldValue.serverTimestamp();
  await ref.update(u);
}

export async function deleteMaterial(input: {
  subAccountId: string;
  lineId: string;
  actor: FieldActor;
}): Promise<void> {
  const { ref, data } = await loadLine(input.subAccountId, input.lineId);
  await assertEditable(data, input.actor);
  await ref.delete();
}
