import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { matchAreasForAddress } from "@/lib/server/service-area-match";
import {
  formatServiceAddress,
  sameServiceAddress,
  sanitizeServiceAddress,
} from "@/lib/field-services/address";
import { issueFieldNumber } from "@/lib/field-services/numbers";
import { getFieldServicesConfig, getJobTerms } from "@/lib/server/field-services-config-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { withArticle } from "@/lib/field-services/terms";
import {
  emitFieldWebhook,
  fireFieldTrigger,
  recordFieldActivity,
  serializeRequest,
} from "@/lib/server/field-events";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type {
  ServiceAddress,
  ServiceArea,
  ServiceRequest,
  ServiceRequestSource,
} from "@/types/field-services";

const SOURCES: ServiceRequestSource[] = [
  "manual",
  "form",
  "booking",
  "ai",
  "workflow",
];
const OPEN_STATUSES = ["new", "scheduled", "action_required"];

export interface ContactSnapshot {
  id: string;
  name: string;
  territoryId: string;
  serviceAddresses: ServiceAddress[];
}

export async function loadContactForField(
  subAccountId: string,
  contactId: string,
): Promise<ContactSnapshot> {
  const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
  const data = snap.data();
  if (!snap.exists || data?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Contact not found.", 404);
  }
  return {
    id: snap.id,
    name: (data?.name as string) || "Customer",
    territoryId:
      typeof data?.territoryId === "string" ? data.territoryId : GLOBAL_TERRITORY_ID,
    serviceAddresses: (data?.serviceAddresses as ServiceAddress[] | undefined) ?? [],
  };
}

export interface AreaCheck {
  outOfArea: boolean;
  areaId: string | null;
  travelFeeCents: number | null;
}

export async function checkServiceArea(
  subAccountId: string,
  address: ServiceAddress | null,
): Promise<AreaCheck> {
  const none: AreaCheck = { outOfArea: false, areaId: null, travelFeeCents: null };
  if (!address) return none;

  const db = getAdminDb();
  const [areasSnap, subSnap, config] = await Promise.all([
    db.collection(`subAccounts/${subAccountId}/serviceAreas`).get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
    getFieldServicesConfig(subAccountId),
  ]);
  const areas = areasSnap.docs.map(
    (d) => ({ id: d.id, ...d.data() }) as ServiceArea,
  );
  if (areas.length === 0) return none;

  const country =
    address.country || (subSnap.data()?.defaultPhoneCountry as string | undefined) || "US";
  const match = await matchAreasForAddress(areas, {
    line1: address.line1,
    city: address.city,
    region: address.region,
    postcode: address.postcode,
    country,
  });
  if (match.status === "in_area") {
    return {
      outOfArea: false,
      areaId: match.area.id,
      travelFeeCents: match.area.travelFeeCents ?? null,
    };
  }
  if (match.status === "out_of_area" && config.outOfAreaPolicy === "block") {
    throw new FieldServicesError(
      "That address is outside your service areas.",
    );
  }
  // An address that could not be checked is not called out of area.
  return { outOfArea: match.status === "out_of_area", areaId: null, travelFeeCents: null };
}

export async function saveAddressOnContact(
  contactId: string,
  address: ServiceAddress | null,
): Promise<void> {
  if (!address || !address.line1) return;
  try {
    const ref = getAdminDb().doc(`contacts/${contactId}`);
    await getAdminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = (snap.data()?.serviceAddresses as ServiceAddress[] | undefined) ?? [];
      if (existing.some((a) => sameServiceAddress(a, address))) return;
      tx.update(ref, { serviceAddresses: [...existing, address].slice(-10) });
    });
  } catch (err) {
    console.warn("[field-services] saving address on contact failed", err);
  }
}

async function duplicateWarnings(
  subAccountId: string,
  contactId: string,
): Promise<string[]> {
  const db = getAdminDb();
  const [requests, jobs] = await Promise.all([
    db.collection("serviceRequests").where("subAccountId", "==", subAccountId).where("contactId", "==", contactId).get(),
    db.collection("jobs").where("subAccountId", "==", subAccountId).where("contactId", "==", contactId).get(),
  ]);
  return [
    ...requests.docs.filter((d) => OPEN_STATUSES.includes(d.data().status)),
    ...jobs.docs.filter((d) => ["unscheduled", "scheduled", "in_progress"].includes(d.data().status)),
  ].map((d) => `${d.data().number} is already open for this customer.`);
}

export interface CreateRequestInput {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  contactId: string;
  title: string;
  description?: string;
  serviceAddress?: unknown;
  serviceIds?: unknown;
  source?: string;
  dealId?: string | null;
  /** Turn the request into a job straight away. On unless a caller asks for the request only. */
  autoConvert?: boolean;
  /** Remember the address on the contact. On unless a caller can't vouch for who sent it. */
  saveAddress?: boolean;
}

export async function createServiceRequest(
  input: CreateRequestInput,
): Promise<{ id: string; number: string; warnings: string[]; jobId: string | null }> {
  const title = input.title?.trim().slice(0, 200);
  if (!title) throw new FieldServicesError("Give the request a title.");

  const contact = await loadContactForField(input.subAccountId, input.contactId);
  const address = sanitizeServiceAddress(input.serviceAddress);
  const area = await checkServiceArea(input.subAccountId, address);
  const warnings = await duplicateWarnings(input.subAccountId, contact.id);

  const serviceIds = Array.isArray(input.serviceIds)
    ? input.serviceIds.filter((s): s is string => typeof s === "string").slice(0, 20)
    : [];
  const source = SOURCES.includes(input.source as ServiceRequestSource)
    ? (input.source as ServiceRequestSource)
    : "manual";

  const db = getAdminDb();
  const number = await issueFieldNumber(input.subAccountId, "request");
  const ref = db.collection("serviceRequests").doc();
  const doc: Omit<ServiceRequest, "id"> = {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    createdByUid: input.createdByUid,
    territoryId: contact.territoryId,
    number,
    contactId: contact.id,
    contactName: contact.name,
    title,
    description: input.description?.trim().slice(0, 4_000) ?? "",
    serviceAddress: address,
    serviceIds,
    photos: [],
    status: "new",
    source,
    dealId: input.dealId ?? null,
    outOfArea: area.outOfArea,
    convertedTo: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);

  const created = { ...doc, id: ref.id, createdAt: new Date() };
  if (input.saveAddress !== false) await saveAddressOnContact(contact.id, address);
  await recordFieldActivity(
    contact.id,
    "field_request",
    `Service request ${number} created: ${title}.`,
    { requestId: ref.id },
  );
  emitFieldWebhook({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    type: "request.created",
    payload: { request: serializeRequest(created) },
  });
  // A workflow that creates requests must not re-trigger itself.
  if (source !== "workflow") {
    fireFieldTrigger({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      type: "request.created",
      contactId: contact.id,
      context: { requestId: ref.id },
    });
  }

  if (area.outOfArea) {
    await createTaskServerSide({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      createdByUid: input.createdByUid,
      mode: "live",
      title: `Out-of-area enquiry from ${contact.name}`,
      notes: `${contact.name} asked for "${title}" at ${formatServiceAddress(address) || "an address with no postcode"}, which is outside your service areas.`,
      dueAt: null,
      contactId: contact.id,
      dealId: null,
      eventId: null,
    }).catch((err) => console.warn("[field-services] out-of-area task failed", err));
  }

  // There is no requests screen by default, so enquiries become jobs that wait to be scheduled.
  // If this fails the request stays open and shows on the Requests tab.
  let jobId: string | null = null;
  if (input.autoConvert !== false) {
    try {
      const { createJobFromRequest } = await import("@/lib/server/field-jobs-service");
      jobId = (
        await createJobFromRequest({
          agencyId: input.agencyId,
          subAccountId: input.subAccountId,
          createdByUid: input.createdByUid,
          requestId: ref.id,
        })
      ).id;
    } catch (err) {
      console.warn("[field-services] turning a request into a job failed", err);
    }
  }

  return { id: ref.id, number, warnings, jobId };
}

async function loadRequest(subAccountId: string, requestId: string) {
  const ref = getAdminDb().doc(`serviceRequests/${requestId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.subAccountId !== subAccountId) {
    throw new FieldServicesError("Request not found.", 404);
  }
  return { ref, data: { id: snap.id, ...snap.data() } as ServiceRequest };
}

/** Deletes a request that never became a job. */
export async function deleteServiceRequest(input: {
  subAccountId: string;
  requestId: string;
}): Promise<void> {
  const { ref, data } = await loadRequest(input.subAccountId, input.requestId);
  if (data.status === "converted" || data.convertedTo) {
    const terms = await getJobTerms(input.subAccountId);
    throw new FieldServicesError(`This request became ${withArticle(terms.job)}. Delete or cancel the ${terms.job} instead.`, 409);
  }
  await ref.delete();
}

export async function updateServiceRequest(input: {
  subAccountId: string;
  requestId: string;
  body: Record<string, unknown>;
}): Promise<void> {
  const { ref, data } = await loadRequest(input.subAccountId, input.requestId);
  const body = input.body;
  const updates: Record<string, unknown> = {};

  if (typeof body.title === "string") {
    const title = body.title.trim().slice(0, 200);
    if (!title) throw new FieldServicesError("Title can't be empty.");
    updates.title = title;
  }
  if (typeof body.description === "string") {
    updates.description = body.description.trim().slice(0, 4_000);
  }
  if (body.serviceAddress !== undefined) {
    if (data.status === "converted") {
      throw new FieldServicesError(`Edit the address on the ${(await getJobTerms(input.subAccountId)).job} instead.`);
    }
    const address = sanitizeServiceAddress(body.serviceAddress);
    const area = await checkServiceArea(input.subAccountId, address);
    updates.serviceAddress = address;
    updates.outOfArea = area.outOfArea;
    await saveAddressOnContact(data.contactId, address);
  }
  if (body.status !== undefined) {
    if (body.status === "archived") {
      if (data.status === "converted") {
        throw new FieldServicesError(`A request that became ${withArticle((await getJobTerms(input.subAccountId)).job)} can't be archived.`);
      }
      updates.status = "archived";
      updates.archiveReason =
        typeof body.archiveReason === "string"
          ? body.archiveReason.trim().slice(0, 200)
          : "";
    } else if (body.status === "new" && data.status === "archived") {
      updates.status = "new";
      updates.archiveReason = null;
    } else {
      throw new FieldServicesError("That status change isn't allowed.");
    }
  }
  if (Object.keys(updates).length === 0) {
    throw new FieldServicesError("Nothing to update.");
  }
  updates.updatedAt = FieldValue.serverTimestamp();
  await ref.update(updates);
}
