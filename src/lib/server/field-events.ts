import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import type { ActivityType } from "@/types/contacts";
import type { WebhookEventType } from "@/types/webhooks";
import type { WorkflowTriggerType } from "@/types/workflows";
import type { Job, ServiceRequest, Visit } from "@/types/field-services";

export function tsToIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const t = v as { toDate?: () => Date; seconds?: number };
  if (typeof t.toDate === "function") return t.toDate().toISOString();
  if (typeof t.seconds === "number") return new Date(t.seconds * 1000).toISOString();
  return null;
}

type Doc<T> = Omit<T, "id"> & { id: string };

export function serializeRequest(r: Doc<ServiceRequest>) {
  return {
    id: r.id,
    object: "service_request",
    number: r.number,
    contact_id: r.contactId,
    title: r.title,
    description: r.description,
    status: r.status,
    source: r.source,
    out_of_area: r.outOfArea === true,
    service_address: r.serviceAddress ?? null,
    job_id: r.convertedTo ?? null,
    created_at: tsToIso(r.createdAt),
  };
}

export function serializeJob(j: Doc<Job>) {
  return {
    id: j.id,
    object: "job",
    number: j.number,
    contact_id: j.contactId,
    request_id: j.requestId ?? null,
    title: j.title,
    description: j.description ?? "",
    status: j.status,
    service_address: j.serviceAddress ?? null,
    timezone: j.timezone,
    out_of_area: j.outOfArea === true,
    invoice_ids: j.invoiceIds,
    completed_at: tsToIso(j.completedAt),
    closed_at: tsToIso(j.closedAt),
    created_at: tsToIso(j.createdAt),
  };
}

export function serializeVisit(v: Doc<Visit>) {
  return {
    id: v.id,
    object: "visit",
    job_id: v.jobId,
    contact_id: v.contactId,
    worker_ids: v.workerIds,
    status: v.status,
    anytime: v.anytime,
    scheduled_start: tsToIso(v.scheduledStart),
    scheduled_end: tsToIso(v.scheduledEnd),
    on_my_way_at: tsToIso(v.onMyWayAt),
    checked_in_at: tsToIso(v.checkedInAt),
    completed_at: tsToIso(v.completedAt),
  };
}

export async function recordFieldActivity(
  contactId: string | null | undefined,
  type: Extract<ActivityType, "field_request" | "field_job" | "field_visit">,
  content: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  if (!contactId) return;
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type,
        content,
        createdBy: "field-services",
        meta,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[field-services] activity write failed", err);
  }
}

export function emitFieldWebhook(input: {
  subAccountId: string;
  agencyId: string;
  type: WebhookEventType;
  payload: unknown;
}): void {
  void emitWebhookEvent({ ...input, mode: "live" });
}

export function fireFieldTrigger(input: {
  subAccountId: string;
  agencyId: string;
  type: WorkflowTriggerType;
  contactId: string | null | undefined;
  context?: Record<string, unknown>;
}): void {
  if (!input.contactId) return;
  void fireWorkflowTrigger({ ...input, contactId: input.contactId });
}
