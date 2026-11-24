"use client";

import { AddressSearch } from "@/components/address/address-search";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  JobStatus,
  ServiceAddress,
  ServiceRequestStatus,
  VisitStatus,
} from "@/types/field-services";
import { jobTerms, withArticle, type JobTerms } from "@/lib/field-services/terms";

export const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground";

export async function callApi<T = Record<string, unknown>>(
  url: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      toast.error(data.error ?? "That didn't work.");
      return null;
    }
    return data;
  } catch {
    toast.error("Couldn't reach the server. Check your connection.");
    return null;
  }
}

type Tone = "neutral" | "info" | "good" | "warn" | "bad";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-primary/10 text-primary",
  good: "bg-[var(--ls-ok-bg)] text-[var(--ls-ok)]",
  warn: "bg-[var(--ls-warn-bg)] text-[var(--ls-warn)]",
  bad: "bg-destructive/10 text-destructive",
};

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={
        "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium " +
        TONES[tone]
      }
    >
      {children}
    </span>
  );
}

function requestStatusLabels(terms: JobTerms): Record<ServiceRequestStatus, [string, Tone]> {
  return {
    new: ["New", "info"],
    scheduled: ["Scheduled", "good"],
    action_required: ["Action needed", "warn"],
    converted: [`Became ${withArticle(terms.job)}`, "neutral"],
    archived: ["Archived", "neutral"],
  };
}

const JOB_STATUS: Record<JobStatus, [string, Tone]> = {
  unscheduled: ["Unscheduled", "warn"],
  scheduled: ["Scheduled", "info"],
  in_progress: ["In progress", "info"],
  ready_to_invoice: ["Ready to invoice", "good"],
  closed: ["Closed", "neutral"],
  cancelled: ["Cancelled", "bad"],
  action_required: ["Action needed", "warn"],
};

const VISIT_STATUS: Record<VisitStatus, [string, Tone]> = {
  pending: ["Scheduled", "neutral"],
  on_my_way: ["On the way", "warn"],
  checked_in: ["Arrived", "info"],
  completed: ["Done", "good"],
  no_show: ["No-show", "bad"],
  cancelled: ["Cancelled", "bad"],
};

export function RequestStatusPill({ status, terms = jobTerms(null) }: { status: ServiceRequestStatus; terms?: JobTerms }) {
  const [label, tone] = requestStatusLabels(terms)[status] ?? [status, "neutral"];
  return <Pill tone={tone}>{label}</Pill>;
}

export function JobStatusPill({ status, invoiced = false }: { status: JobStatus; invoiced?: boolean }) {
  const [label, tone] = invoiced && status === "ready_to_invoice" ? ["Invoiced", "info" as Tone] : (JOB_STATUS[status] ?? [status, "neutral" as Tone]);
  return <Pill tone={tone}>{label}</Pill>;
}

export function VisitStatusPill({ status, manyVisits = false }: { status: VisitStatus; manyVisits?: boolean }) {
  const [base, tone] = VISIT_STATUS[status] ?? [status, "neutral"];
  // With several visits on one project, a finished visit is not a finished project.
  const label = manyVisits && status === "completed" ? "Visit done" : base;
  return <Pill tone={tone}>{label}</Pill>;
}

export const EMPTY_ADDRESS: ServiceAddress = {
  line1: "",
  city: "",
  region: "",
  postcode: "",
  country: "",
};

export function AddressFields({
  value,
  onChange,
  disabled,
}: {
  value: ServiceAddress;
  onChange: (next: ServiceAddress) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<ServiceAddress>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-6">
      <AddressSearch
        className="sm:col-span-6"
        disabled={disabled}
        country={value.country || undefined}
        onPick={(a) =>
          onChange({ ...value, line1: a.line1, city: a.city, region: a.region, postcode: a.postcode, country: a.country })
        }
      />
      <div className="sm:col-span-4">
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">
          Street address
        </Label>
        <Input
          value={value.line1}
          onChange={(e) => set({ line1: e.target.value })}
          disabled={disabled}
        />
      </div>
      <div className="sm:col-span-2">
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">
          Unit / suite
        </Label>
        <Input
          value={value.line2 ?? ""}
          onChange={(e) => set({ line2: e.target.value })}
          disabled={disabled}
        />
      </div>
      <div className="sm:col-span-3">
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">
          City / suburb
        </Label>
        <Input
          value={value.city}
          onChange={(e) => set({ city: e.target.value })}
          disabled={disabled}
        />
      </div>
      <div className="sm:col-span-1">
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">
          State
        </Label>
        <Input
          value={value.region}
          onChange={(e) => set({ region: e.target.value })}
          disabled={disabled}
        />
      </div>
      <div className="sm:col-span-1">
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">
          Postcode
        </Label>
        <Input
          value={value.postcode}
          onChange={(e) => set({ postcode: e.target.value })}
          disabled={disabled}
        />
      </div>
      <div className="sm:col-span-1">
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">
          Country
        </Label>
        <Input
          value={value.country}
          onChange={(e) => set({ country: e.target.value.toUpperCase().slice(0, 2) })}
          placeholder="US"
          disabled={disabled}
        />
      </div>
    </div>
  );
}

export function addressIsEmpty(a: ServiceAddress): boolean {
  return !a.line1.trim() && !a.city.trim() && !a.postcode.trim();
}
