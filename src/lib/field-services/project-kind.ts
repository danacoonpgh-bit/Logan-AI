import { BILLING_TYPE_LABELS, type JobBillingType } from "@/types/field-services";
import { effectiveBillingType } from "@/lib/field-services/billing-type";

export type ProjectKind = JobBillingType | "internal";

export const PROJECT_KIND_LABELS: Record<ProjectKind, string> = {
  ...BILLING_TYPE_LABELS,
  internal: "Internal",
};

/** A faint tint for a row or card, a slightly stronger edge stripe and a small chip. */
export const PROJECT_KIND_STYLE: Record<ProjectKind, { tint: string; edge: string; chip: string }> = {
  time_and_materials: {
    tint: "bg-sky-500/[0.04]",
    edge: "border-l-sky-400/70",
    chip: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  day_rate: {
    tint: "bg-violet-500/[0.04]",
    edge: "border-l-violet-400/70",
    chip: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  lump_sum: {
    tint: "bg-emerald-500/[0.04]",
    edge: "border-l-emerald-400/70",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  internal: {
    tint: "bg-slate-500/[0.05]",
    edge: "border-l-slate-400/70",
    chip: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
  },
};

/** A project without a billing type reads as time and materials. */
export function projectKindOf(job: { billingType?: JobBillingType | null; invoiceIds?: string[] }): ProjectKind {
  return effectiveBillingType(job);
}
