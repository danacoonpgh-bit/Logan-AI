import type { JobStatus, VisitStatus } from "@/types/field-services";

export function deriveJobStatus(
  current: JobStatus,
  visitStatuses: VisitStatus[],
  opts: { repeating?: boolean } = {},
): JobStatus {
  if (current === "closed" || current === "cancelled") return current;
  const live = visitStatuses.filter((s) => s !== "cancelled");
  if (live.length === 0) return "unscheduled";
  if (live.some((s) => s === "on_my_way" || s === "checked_in")) {
    return "in_progress";
  }
  // Some visits are done but more are still booked: the work is under way, not finished.
  if (live.some((s) => s === "pending")) {
    // A repeating project always has a next visit booked, so a finished one does not make it in progress.
    return !opts.repeating && live.some((s) => s === "completed") ? "in_progress" : "scheduled";
  }
  if (live.some((s) => s === "completed")) return "ready_to_invoice";
  return "action_required";
}

export function hasOpenVisit(visitStatuses: VisitStatus[]): boolean {
  return visitStatuses.some(
    (s) => s === "pending" || s === "on_my_way" || s === "checked_in",
  );
}

/**
 * Finished work that already has an invoice. A repeating project is billed visit by visit, so it never counts.
 */
export function isInvoiced(job: { status: JobStatus; jobType?: string; invoiceIds?: string[]; invoiceClean?: boolean }): boolean {
  if (job.status !== "ready_to_invoice" || job.jobType === "recurring") return false;
  if (job.invoiceClean !== undefined) return job.invoiceClean;
  return (job.invoiceIds?.length ?? 0) > 0;
}
