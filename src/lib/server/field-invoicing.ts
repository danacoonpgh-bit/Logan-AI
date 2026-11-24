import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { effectiveBillingType } from "@/lib/field-services/billing-type";
import type { Job } from "@/types/field-services";

/** Which invoice ids still exist; billing marks on a deleted invoice no longer count. */
export async function existingInvoiceIds(ids: (string | null | undefined)[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const db = getAdminDb();
  const snaps = await Promise.all(unique.map((id) => db.doc(`quotes/${id}`).get()));
  return new Set(snaps.filter((s) => s.exists).map((s) => s.id));
}

/**
 * For a project invoiced before extra work was tracked per invoice: extra work answered before the latest live invoice counts as billed on it.
 */
export async function legacyBilledApprovals(job: Job): Promise<Set<string>> {
  const out = new Set<string>();
  const invoiceIds = job.invoiceIds ?? [];
  if (job.jobType === "recurring" || job.billedLinesInvoiceId !== undefined || invoiceIds.length === 0) return out;
  const db = getAdminDb();
  const invoices = await Promise.all(invoiceIds.slice(-20).map((id) => db.doc(`quotes/${id}`).get()));
  let last = 0;
  for (const snap of invoices) {
    if (!snap.exists) continue;
    const t = (snap.data()?.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    if (t > last) last = t;
  }
  if (!last) return out;
  const approvals = await db.collection("jobApprovals").where("jobId", "==", job.id).get();
  for (const a of approvals.docs) {
    const d = a.data();
    if (d.status !== "approved" || job.billedApprovals?.[a.id]) continue;
    const at = (d.respondedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    if (at && at <= last) out.add(a.id);
  }
  return out;
}

/** What a project has that no live invoice carries yet, in words. Empty when everything is billed. */
export async function unbilledWork(job: Job): Promise<string[]> {
  const db = getAdminDb();
  const lump = effectiveBillingType(job) === "lump_sum";
  const recurring = job.jobType === "recurring";
  const [timeSnap, partSnap, visitSnap, legacy] = await Promise.all([
    lump ? null : db.collection("timeEntries").where("jobId", "==", job.id).get(),
    db.collection("materialLines").where("jobId", "==", job.id).get(),
    recurring ? db.collection("visits").where("jobId", "==", job.id).get() : null,
    legacyBilledApprovals(job),
  ]);

  const ids: (string | null | undefined)[] = [
    ...Object.values(job.billedApprovals ?? {}),
    job.billedLinesInvoiceId,
    ...(job.billedLinesInvoiceId ? [] : (job.invoiceIds ?? [])),
  ];
  for (const d of timeSnap?.docs ?? []) ids.push(d.data().invoiceId as string | undefined);
  for (const d of partSnap.docs) ids.push(d.data().invoiceLineId as string | undefined);
  for (const d of visitSnap?.docs ?? []) ids.push(d.data().invoiceId as string | undefined);
  const alive = await existingInvoiceIds(ids);

  const out: string[] = [];

  let hours = 0;
  let running = false;
  for (const d of timeSnap?.docs ?? []) {
    const e = d.data();
    if (e.subAccountId !== job.subAccountId || e.voided === true || e.billable === false) continue;
    if (e.running) {
      running = true;
      continue;
    }
    if (e.invoiceId && alive.has(e.invoiceId as string)) continue;
    const s = (e.startAt as { toMillis?: () => number } | null)?.toMillis?.();
    const en = (e.endAt as { toMillis?: () => number } | null)?.toMillis?.();
    if (s && en && en > s) hours += (en - s) / 3_600_000;
  }
  if (running) out.push("a timer that is still running");
  if (hours > 0) out.push(`${Math.round(hours * 100) / 100} h of billable time`);

  const parts = partSnap.docs.filter((d) => {
    const m = d.data();
    // A part with no price never makes an invoice line, so it is not owed.
    return (
      m.subAccountId === job.subAccountId &&
      m.billable !== false &&
      Number(m.unitPriceMinor) > 0 &&
      !(m.invoiceLineId && alive.has(m.invoiceLineId as string))
    );
  }).length;
  if (parts > 0) out.push(parts === 1 ? "1 part" : `${parts} parts`);

  if (recurring) {
    const visits = (visitSnap?.docs ?? []).filter(
      (d) => d.data().status === "completed" && !(d.data().invoiceId && alive.has(d.data().invoiceId as string)),
    ).length;
    if (visits > 0) out.push(visits === 1 ? "1 finished visit" : `${visits} finished visits`);
  } else {
    const ownBilled = job.billedLinesInvoiceId
      ? alive.has(job.billedLinesInvoiceId)
      : job.billedLinesInvoiceId === undefined && (job.invoiceIds ?? []).some((i) => alive.has(i));
    const unbilledLines = (job.lineItems ?? []).some((l) => {
      if (!(l.quantity * l.unitPriceMinor > 0)) return false;
      if (!l.approvalId) return !ownBilled;
      const inv = job.billedApprovals?.[l.approvalId];
      return !(inv && alive.has(inv)) && !(!inv && legacy.has(l.approvalId));
    });
    if (unbilledLines) out.push("the charges on the project");
  }
  return out;
}

/** Works out and stores whether a project's invoices cover everything billable, so lists can tell Invoiced from Ready to invoice. */
export async function refreshInvoicedFlag(subAccountId: string, jobId: string): Promise<void> {
  const ref = getAdminDb().doc(`jobs/${jobId}`);
  const job = (await ref.get()).data() as Job | undefined;
  if (!job || job.subAccountId !== subAccountId || job.jobType === "recurring") return;
  if (job.status !== "ready_to_invoice") return;
  const alive = await existingInvoiceIds(job.billedLinesInvoiceId ? [job.billedLinesInvoiceId] : (job.invoiceIds ?? []));
  const clean = alive.size > 0 && (await unbilledWork({ ...job, id: jobId })).length === 0;
  if (job.invoiceClean !== clean) await ref.update({ invoiceClean: clean });
}
