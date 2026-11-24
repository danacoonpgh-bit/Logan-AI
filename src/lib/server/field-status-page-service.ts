import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatServiceAddress } from "@/lib/field-services/address";
import { readJobStatusToken } from "@/lib/field-services/job-status-token";
import { describeRecurrence } from "@/lib/field-services/recurrence";
import { tsToIso } from "@/lib/server/field-events";
import { hitLimit } from "@/lib/server/field-rate-limit";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { jobTerms } from "@/lib/field-services/terms";
import { loadPublicBookingConfig, publicLook } from "@/lib/server/field-booking-service";
import { changeRights, moveService } from "@/lib/server/field-customer-change-service";
import type { ExtraWorkApproval, Job, Visit } from "@/types/field-services";
import type { SubAccountDoc } from "@/types/tenancy";

export interface StatusPageData {
  business: string;
  /** How the page looks and where else the customer can go. */
  look: {
    theme: "light" | "dark" | "auto";
    style: string;
    accent: string;
    logoUrl: string | null;
    contact: { email: string | null; phone: string | null };
    portalHref: string | null;
    bookingHref: string | null;
  };
  jobWord: string;
  jobWordPlural: string;
  job: {
    number: string;
    title: string;
    address: string;
    timezone: string;
    closed: boolean;
    cancelled: boolean;
    repeats: string | null;
  };
  visits: {
    id: string;
    start: string | null;
    anytime: boolean;
    status: Visit["status"];
    tech: string;
    canCancel: boolean;
    canMove: boolean;
    /** Too close to change online: the page shows the phone number. */
    locked: boolean;
  }[];
  /** Hours before a visit that the customer can still cancel or move it; 0 when they can't. */
  changeHours: number;
  /** The refund policy text, shown with the cancel button when a deposit was paid. */
  refundNote: string;
  signoffs: {
    id: string;
    visitId: string;
    status: "pending" | "signed";
    start: string | null;
    anytime: boolean;
    tech: string;
    checklist: { text: string; done: boolean }[];
    signedBy: string;
  }[];
  approvals: {
    id: string;
    status: ExtraWorkApproval["status"];
    totalMinor: number;
    currency: string;
    note: string;
    lines: { description: string; quantity: number; unitPriceMinor: number }[];
  }[];
}

const SHOW_AFTER_CLOSE_MS = 180 * 24 * 3_600_000;

/** The workspace's own word for a job, for the "link isn't working" page. Defaults when the link is unreadable. */
export async function loadStatusTerms(token: unknown) {
  const parsed = readJobStatusToken(token);
  if (!parsed) return jobTerms(null);
  try {
    const snap = await getAdminDb().doc(`jobs/${parsed.jobId}`).get();
    const subAccountId = snap.data()?.subAccountId as string | undefined;
    return subAccountId ? jobTerms(await getFieldServicesConfig(subAccountId)) : jobTerms(null);
  } catch {
    return jobTerms(null);
  }
}

/** What a customer sees from their link. Null when the link is wrong, revoked or too old. */
export async function loadStatusPage(token: unknown, ip: string): Promise<StatusPageData | null> {
  const limit = await hitLimit(`jobpage:ip:${ip}`, 120, 3_600_000);
  if (!limit.ok) return null;
  const parsed = readJobStatusToken(token);
  if (!parsed) return null;

  const db = getAdminDb();
  const jobSnap = await db.doc(`jobs/${parsed.jobId}`).get();
  const job = jobSnap.data() as Job | undefined;
  if (!job || (job.statusTokenVersion ?? 1) !== parsed.version) return null;
  const closedAt = (job.closedAt as Timestamp | undefined)?.toMillis?.();
  if (job.status === "closed" && closedAt && Date.now() - closedAt > SHOW_AFTER_CLOSE_MS) return null;

  const [subSnap, visitSnap, approvalSnap, signoffSnap, config] = await Promise.all([
    db.doc(`subAccounts/${job.subAccountId}`).get(),
    db.collection("visits").where("jobId", "==", parsed.jobId).get(),
    db.collection("jobApprovals").where("jobId", "==", parsed.jobId).get(),
    db.collection("visitSignoffs").where("jobId", "==", parsed.jobId).get(),
    getFieldServicesConfig(job.subAccountId),
  ]);
  const terms = jobTerms(config);
  const sub = subSnap.data();
  if (!sub || !fieldServicesAvailable(sub)) return null;

  const visitDocs = visitSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Visit)
    .filter((v) => v.subAccountId === job.subAccountId && v.status !== "cancelled")
    .sort(
      (a, b) =>
        ((a.scheduledStart as Timestamp | null)?.toMillis?.() ?? 0) -
        ((b.scheduledStart as Timestamp | null)?.toMillis?.() ?? 0),
    );
  const nowMs = Date.now();
  const startMs = (v: Visit) => (v.scheduledStart as Timestamp | null)?.toMillis?.() ?? 0;
  const shown =
    job.jobType === "recurring"
      ? [
          ...visitDocs.filter((v) => startMs(v) < nowMs).slice(-3),
          ...visitDocs.filter((v) => startMs(v) >= nowMs).slice(0, 10),
        ]
      : visitDocs;
  const liveCount = visitDocs.filter((v) => ["pending", "on_my_way", "checked_in"].includes(v.status)).length;
  const invoiced = (job.invoiceIds?.length ?? 0) > 0 || !!job.quoteId || !!job.travelFeeInvoiceId;
  const workerIds = [...new Set(shown.flatMap((v) => v.workerIds))].slice(0, 20);
  const workers = await Promise.all(workerIds.map((id) => db.doc(`fieldWorkers/${id}`).get()));
  const first = new Map(
    workers.map((w) => [w.id, ((w.data()?.name as string | undefined) ?? "").trim().split(/\s+/)[0] ?? ""]),
  );

  const look = publicLook(sub as SubAccountDoc, config);
  const canMove = (await moveService(config, { ...job, id: parsed.jobId })) !== null;
  return {
    business: (sub.name as string) || "Your service team",
    look: {
      ...look,
      accent: config.bookingAccent ?? "",
      portalHref: config.customerPortalEnabled === true ? `/customer/${job.subAccountId}` : null,
      // Only when the booking page itself would open.
      bookingHref: (await loadPublicBookingConfig(job.subAccountId).catch(() => null))
        ? `/book-service/${job.subAccountId}`
        : null,
    },
    jobWord: terms.Job,
    jobWordPlural: terms.Jobs,
    job: {
      number: job.number,
      title: job.title,
      address: formatServiceAddress(job.serviceAddress),
      timezone: job.timezone,
      closed: job.status === "closed",
      cancelled: job.status === "cancelled",
      repeats:
        job.jobType === "recurring" && job.recurrence?.active ? describeRecurrence(job.recurrence) : null,
    },
    signoffs: signoffSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown> & { id: string })
      .filter((x) => x.subAccountId === job.subAccountId && (x.status === "pending" || x.status === "signed"))
      .flatMap((x) => {
        const v = visitDocs.find((vd) => vd.id === x.visitId);
        if (!v) return [];
        const signed = x.status === "signed";
        const items = (
          signed
            ? ((x.checklist as { text: string; done: boolean; source?: string }[] | undefined) ?? [])
            : (v.checklist ?? [])
        ).filter((i) => i.source !== "added");
        return [
          {
            id: x.id,
            visitId: v.id,
            status: x.status as "pending" | "signed",
            start: tsToIso(v.scheduledStart),
            anytime: v.anytime,
            tech: v.workerIds.map((id) => first.get(id) ?? "").filter(Boolean).join(" & "),
            checklist: items.map((i) => ({ text: String(i.text).slice(0, 120), done: i.done === true })),
            signedBy: signed ? String((x.response as { name?: string } | undefined)?.name ?? "") : "",
          },
        ];
      })
      .slice(0, 20),
    changeHours: config.customerChangeHours ?? 72,
    refundNote: (job.depositPaidMinor ?? 0) > 0 ? (config.bookingRefundPolicy ?? "").slice(0, 600) : "",
    visits: shown.map((v) => {
      const r = changeRights(config, { ...job, id: parsed.jobId }, v, canMove);
      // The last visit of an invoiced project cannot be cancelled online, so the page shows the phone number instead.
      const noCancel = r.canCancel && invoiced && liveCount === 1;
      return {
        id: v.id,
        start: tsToIso(v.scheduledStart),
        anytime: v.anytime,
        status: v.status,
        tech: v.workerIds.map((id) => first.get(id) ?? "").filter(Boolean).join(" & "),
        canCancel: r.canCancel && !noCancel,
        canMove: r.canMove,
        locked: r.locked || noCancel,
      };
    }),
    approvals: approvalSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }) as ExtraWorkApproval)
      .filter((a) => a.subAccountId === job.subAccountId && a.status !== "cancelled")
      .sort(
        (a, b) =>
          ((b.createdAt as Timestamp | undefined)?.toMillis?.() ?? 0) -
          ((a.createdAt as Timestamp | undefined)?.toMillis?.() ?? 0),
      )
      .map((a) => ({
        id: a.id,
        status: a.status,
        totalMinor: a.totalMinor,
        currency: a.currency,
        note: a.note,
        lines: a.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor,
        })),
      })),
  };
}
