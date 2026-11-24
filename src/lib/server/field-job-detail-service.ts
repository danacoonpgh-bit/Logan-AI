import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getJobTerms } from "@/lib/server/field-services-config-service";
import { existingInvoiceIds, refreshInvoicedFlag } from "@/lib/server/field-invoicing";
import { tsToIso } from "@/lib/server/field-events";
import type {
  Job,
  JobPayment,
  MaterialLine,
  PhotoRef,
  TimeEntry,
  Visit,
} from "@/types/field-services";

export interface JobDetail {
  time: {
    id: string;
    visitId: string | null;
    workerId: string;
    kind: string;
    startAt: string | null;
    endAt: string | null;
    hoursOnly: boolean;
    minutes: number | null;
    date: string | null;
    running: boolean;
    billable: boolean;
    voided: boolean;
    source: string;
    autoClosed: boolean;
    invoiced: boolean;
    correctionNote: string | null;
  }[];
  materials: {
    id: string;
    visitId: string;
    name: string;
    qty: number;
    unit: string;
    unitPriceMinor: number;
    unitCostMinor: number;
    taxable: boolean;
    billable: boolean;
    notInEstimate: boolean;
    invoiced: boolean;
  }[];
  payments: {
    id: string;
    visitId: string;
    method: string;
    amountMinor: number;
    currency: string;
    status: string;
    invoiceId: string | null;
    note: string;
  }[];
  photos: (Pick<PhotoRef, "id" | "label" | "takenAt" | "note"> & { visitId: string })[];
}

/** `onlyWorkerId` limits the time list to one worker's own entries. */
export async function getJobDetail(
  subAccountId: string,
  jobId: string,
  onlyWorkerId?: string | null,
): Promise<JobDetail> {
  const db = getAdminDb();
  const jobSnap = await db.doc(`jobs/${jobId}`).get();
  const job = jobSnap.data() as Job | undefined;
  if (!jobSnap.exists || !job || job.subAccountId !== subAccountId) {
    throw new FieldServicesError(`${(await getJobTerms(subAccountId)).Job} not found.`, 404);
  }
  if (job.status === "ready_to_invoice") await refreshInvoicedFlag(subAccountId, jobId).catch(() => {});
  const [time, mats, pays, visits] = await Promise.all([
    db.collection("timeEntries").where("jobId", "==", jobId).get(),
    db.collection("materialLines").where("jobId", "==", jobId).get(),
    db.collection("jobPayments").where("jobId", "==", jobId).get(),
    db.collection("visits").where("jobId", "==", jobId).get(),
  ]);
  const inTenant = <T extends { subAccountId?: string }>(d: T) => d.subAccountId === subAccountId;
  const alive = await existingInvoiceIds([
    ...time.docs.map((d) => d.data().invoiceId as string | undefined),
    ...mats.docs.map((d) => d.data().invoiceLineId as string | undefined),
  ]);

  return {
    time: time.docs
      .map((d) => ({ id: d.id, ...d.data() }) as TimeEntry & { autoClosed?: boolean; invoicedAt?: unknown; invoiceId?: string })
      .filter(inTenant)
      .filter((e) => !onlyWorkerId || e.workerId === onlyWorkerId)
      .map((e) => ({
        id: e.id,
        visitId: e.visitId,
        workerId: e.workerId,
        kind: e.kind,
        startAt: (e as { hoursOnly?: boolean }).hoursOnly === true ? null : tsToIso(e.startAt),
        endAt: (e as { hoursOnly?: boolean }).hoursOnly === true ? null : tsToIso(e.endAt),
        hoursOnly: (e as { hoursOnly?: boolean }).hoursOnly === true,
        minutes: (e as { durationMinutes?: number }).durationMinutes ?? null,
        date: (e as { workDate?: string }).workDate ?? null,
        running: e.running,
        billable: e.billable,
        voided: e.voided === true,
        source: e.source,
        autoClosed: e.autoClosed === true,
        invoiced: !!e.invoicedAt && (!e.invoiceId || alive.has(e.invoiceId)),
        correctionNote: e.correctionRequest?.note ?? null,
      })),
    materials: mats.docs
      .map((d) => ({ id: d.id, ...d.data() }) as MaterialLine)
      .filter(inTenant)
      .map((m) => ({
        id: m.id,
        visitId: m.visitId,
        name: m.name,
        qty: m.qty,
        unit: m.unit,
        unitPriceMinor: m.unitPriceMinor,
        unitCostMinor: m.unitCostMinor,
        taxable: m.taxable,
        billable: m.billable,
        notInEstimate: m.notInEstimate,
        invoiced: !!m.invoiceLineId && alive.has(m.invoiceLineId),
      })),
    payments: pays.docs
      .map((d) => ({ id: d.id, ...d.data() }) as JobPayment)
      .filter(inTenant)
      .map((p) => ({
        id: p.id,
        visitId: p.visitId,
        method: p.method,
        amountMinor: p.amountMinor,
        currency: p.currency,
        status: p.status,
        invoiceId: p.invoiceId ?? null,
        note: p.note,
      })),
    photos: visits.docs.flatMap((d) => {
      const v = { id: d.id, ...d.data() } as Visit;
      if (v.subAccountId !== subAccountId) return [];
      return (v.photos ?? []).map((p) => ({
        id: p.id,
        label: p.label,
        takenAt: p.takenAt,
        note: p.note ?? null,
        visitId: v.id,
      }));
    }),
  };
}
