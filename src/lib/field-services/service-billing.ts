import type { JobBillingType } from "@/types/field-services";

/** The billing type a service carries. A service saved before this existed reads as fixed price. */
export function serviceBilling(p: { billingType?: JobBillingType } | undefined): JobBillingType {
  return p?.billingType ?? "lump_sum";
}

/** What a project made from these services should bill as: their shared type, or null when they differ or there are none. */
export function billingFromServices(services: { billingType?: JobBillingType }[]): JobBillingType | null {
  if (services.length === 0) return null;
  const types = new Set(services.map((s) => serviceBilling(s)));
  return types.size === 1 ? [...types][0] : null;
}
