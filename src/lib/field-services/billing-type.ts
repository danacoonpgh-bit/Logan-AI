import type { JobBillingType } from "@/types/field-services";

/**
 * The billing type a project really behaves as. Day rate is no longer offered, so a project still set to it reads as
 * time and materials until it has an invoice; after that it keeps billing by the day so what was invoiced stays true.
 */
export function effectiveBillingType(job: { billingType?: JobBillingType | null; invoiceIds?: string[] }): JobBillingType {
  const type = job.billingType ?? "time_and_materials";
  return type === "day_rate" && (job.invoiceIds?.length ?? 0) === 0 ? "time_and_materials" : type;
}
