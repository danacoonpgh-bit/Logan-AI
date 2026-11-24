"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { billingFromServices } from "@/lib/field-services/service-billing";
import { PROJECT_KIND_LABELS, PROJECT_KIND_STYLE, projectKindOf } from "@/lib/field-services/project-kind";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Plus } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ContactPicker } from "@/components/quotes/contact-picker";
import { SELECT_CLASS } from "@/components/field-services/field-ui";
import { useFieldData } from "@/components/field-services/field-data";
import { subscribeToDeals } from "@/lib/firestore/deals";
import { usePipelines, useDealStageResolver } from "@/hooks/use-pipelines";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { formatCurrency } from "@/lib/format";
import { workspaceCurrencyOf } from "@/lib/field-services/money";
import { InternalJobsSection } from "@/components/field-services/internal-jobs-section";
import type { Deal } from "@/types/deals";
import { InvoiceRunDialog } from "@/components/field-services/invoice-run-dialog";
import { jobTerms, withArticle, workerTerms } from "@/lib/field-services/terms";
import {
  billingTypeHints,
  BillingTypeSelect,
  useFieldConfig,
} from "@/components/field-services/timesheets-ui";
import {
  AddressFields,
  EMPTY_ADDRESS,
  JobStatusPill,
  addressIsEmpty,
  callApi,
} from "@/components/field-services/field-ui";
import { formatServiceAddress } from "@/lib/field-services/address";
import { StaffPicker } from "@/components/field-services/staff-picker";
import { jobAllowanceMinutes } from "@/lib/field-services/duration";
import { utcToZonedInput, zonedTimeToUtc } from "@/lib/field-services/time";
import { isInvoiced } from "@/lib/field-services/job-status";
import { formatMoneyCode, minorToUnit, unitToMinor } from "@/lib/field-services/money";
import type {
  JobBillingType,
  JobLineItem,
  Job,
  JobStatus,
  ServiceAddress,
} from "@/types/field-services";

export type Filter = "active" | "unscheduled" | "ready_to_invoice" | "closed" | "all";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "unscheduled", label: "Needs scheduling" },
  { id: "ready_to_invoice", label: "Ready to invoice" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

const DONE: JobStatus[] = ["closed", "cancelled"];

function matches(filter: Filter, job: Pick<Job, "status" | "jobType" | "invoiceIds">): boolean {
  const status = job.status;
  switch (filter) {
    case "all":
      return true;
    case "active":
      return !DONE.includes(status);
    case "unscheduled":
      return status === "unscheduled" || status === "action_required";
    case "ready_to_invoice":
      return status === "ready_to_invoice" && !isInvoiced(job);
    case "closed":
      return DONE.includes(status);
  }
}

function DecimalInput({
  value,
  onCommit,
  disabled,
  className,
}: {
  value: number;
  onCommit: (n: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Input
      className={className}
      inputMode="decimal"
      value={text}
      disabled={disabled}
      onChange={(e) => {
        const t = e.target.value;
        if (!/^\d*\.?\d*$/.test(t)) return;
        setText(t);
        onCommit(t === "" || t === "." ? 0 : Number(t));
      }}
    />
  );
}

export interface LineStaff {
  id: string;
  name: string;
  sellMinor: number;
  costMinor: number;
}

export function LinesEditor({
  currency,
  lines,
  onChange,
  disabled,
  staff,
  activities,
  estimate,
}: {
  currency: string;
  lines: JobLineItem[];
  onChange: (next: JobLineItem[]) => void;
  disabled?: boolean;
  /** When given, each line can name a staff member: the quantity is their hours and the price their sell rate. */
  staff?: LineStaff[];
  /** With staff: a staff line names an activity from this list instead of free text. */
  activities?: { id: string; label: string }[];
  /** These lines are an internal estimate: a Time & materials service can be added as hours at its rate. Charge lines never offer one. */
  estimate?: boolean;
}) {
  const { services: allServices } = useFieldData();
  const services = allServices.filter((s) => estimate === true || s.billingType !== "time_and_materials");
  const update = (i: number, patch: Partial<JobLineItem>) =>
    onChange(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const lineTotal = (l: JobLineItem) => Math.round(l.quantity * l.unitPriceMinor);
  const grandTotal = lines.reduce((n, l) => n + lineTotal(l), 0);
  // hours only add up across staff lines; parts and fees are not hours
  const hoursTotal = lines.reduce((n, l) => n + (l.workerId ? l.quantity : 0), 0);
  const cols = staff
    ? "grid-cols-[minmax(0,1.6fr)_minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.1fr)_2rem]"
    : "grid-cols-[minmax(0,3fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_2rem]";
  const head = "px-1 text-xs font-medium text-muted-foreground";

  return (
    <div className="space-y-2">
      {lines.length > 0 && (
        <div className={`grid items-end gap-2 ${cols}`}>
          {staff && <span className={head}>Staff</span>}
          <span className={head}>{activities && activities.length > 0 ? "Activity / description" : "Description"}</span>
          <span className={head}>{staff ? "Hours / qty" : "Qty"}</span>
          <span className={head}>Price</span>
          <span className={`${head} text-right`}>Total</span>
          <span />
        </div>
      )}
      {lines.map((l, i) => (
        <div key={l.id} className={`grid items-center gap-2 ${cols}`}>
          {staff && (
            <select
              className="h-9 min-w-0 rounded-md border border-input bg-transparent px-2 text-sm [&_option]:bg-background [&_option]:text-foreground"
              value={l.workerId ?? ""}
              disabled={disabled}
              aria-label="Staff member"
              onChange={(e) => {
                const w = staff.find((x) => x.id === e.target.value);
                if (!w) update(i, { workerId: null, activityId: null });
                else update(i, { workerId: w.id, unitPriceMinor: w.sellMinor, priceLocked: false });
              }}
            >
              <option value="">No staff</option>
              {staff.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          {l.workerId && activities && activities.length > 0 ? (
            <select
              className="h-9 min-w-0 rounded-md border border-input bg-transparent px-2 text-sm [&_option]:bg-background [&_option]:text-foreground"
              value={activities.some((a) => a.id === l.activityId) ? (l.activityId ?? "") : ""}
              disabled={disabled}
              aria-label="Activity"
              onChange={(e) => {
                const a = activities.find((x) => x.id === e.target.value);
                update(i, { activityId: a?.id ?? null, description: a?.label ?? "" });
              }}
            >
              <option value="">{l.description && !activities.some((a) => a.id === l.activityId) ? l.description : "Choose activity…"}</option>
              {activities.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              className="min-w-0"
              value={l.description}
              onChange={(e) => update(i, { description: e.target.value })}
              placeholder="Description"
              disabled={disabled}
            />
          )}
          <DecimalInput
            className="min-w-0"
            value={l.quantity}
            onCommit={(n) => update(i, { quantity: n })}
            disabled={disabled}
          />
          <DecimalInput
            className="min-w-0"
            value={minorToUnit(currency, l.unitPriceMinor)}
            onCommit={(n) => {
              const minor = unitToMinor(currency, n);
              if (minor === l.unitPriceMinor) return;
              update(i, { unitPriceMinor: minor, ...(l.workerId ? { priceLocked: true } : {}) });
            }}
            disabled={disabled}
          />
          <span className="truncate text-right text-sm tabular-nums">{formatMoneyCode(currency, lineTotal(l))}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Remove line"
            disabled={disabled}
            onClick={() => onChange(lines.filter((_, idx) => idx !== i))}
          >
            ×
          </Button>
        </div>
      ))}
      {lines.length > 0 && (
        <div className={`grid items-center gap-2 border-t pt-2 text-sm font-semibold ${cols}`}>
          {staff && <span />}
          <span className="px-1">Total</span>
          <span className="px-1 tabular-nums">{staff && hoursTotal > 0 ? `${Math.round(hoursTotal * 100) / 100} h` : ""}</span>
          <span />
          <span className="truncate text-right tabular-nums">{formatMoneyCode(currency, grandTotal)}</span>
          <span />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...lines,
              {
                id: crypto.randomUUID().slice(0, 8),
                description: "",
                quantity: 1,
                unitPriceMinor: 0,
              },
            ])
          }
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add line
        </Button>
        {services.length > 0 && (
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs [&_option]:bg-background [&_option]:text-foreground"
            value=""
            disabled={disabled}
            onChange={(e) => {
              const [serviceId, variantId] = e.target.value.split(":");
              const s = services.find((p) => p.id === serviceId);
              if (!s) return;
              const v = variantId ? s.variants?.find((x) => x.id === variantId) : undefined;
              if (s.billingType === "time_and_materials" && s.estimateRateCents) {
                const hours = Math.round(((s.durationMinutes && s.durationMinutes > 0 ? s.durationMinutes : 60) / 60) * 10_000) / 10_000;
                onChange([
                  ...lines,
                  {
                    id: crypto.randomUUID().slice(0, 8),
                    description: s.name,
                    quantity: hours,
                    unitPriceMinor: unitToMinor(currency, s.estimateRateCents / 100),
                    productId: s.id,
                  },
                ]);
                return;
              }
              onChange([
                ...lines,
                {
                  id: crypto.randomUUID().slice(0, 8),
                  description: v ? `${s.name} (${v.name})` : s.name,
                  quantity: 1,
                  unitPriceMinor: unitToMinor(currency, (v ? v.unitPriceCents : s.unitPriceCents) / 100),
                  productId: s.id,
                  ...(v ? { variantId: v.id, durationMinutes: v.durationMinutes > 0 ? v.durationMinutes : null } : {}),
                },
              ]);
            }}
          >
            <option value="">Add a service…</option>
            {services.flatMap((s) =>
              s.variants && s.variants.length > 0
                ? s.variants.map((v) => (
                    <option key={`${s.id}:${v.id}`} value={`${s.id}:${v.id}`}>
                      {s.name} ({v.name})
                    </option>
                  ))
                : [
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>,
                  ],
            )}
          </select>
        )}
      </div>
    </div>
  );
}

function NewJobDialog({
  open,
  onOpenChange,
  onCreated,
  onInternal,
  initialDealId = "",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
  /** Internal was picked as the type: the caller opens the internal project form instead. */
  onInternal: () => void;
  /** A won deal to start from, for example from its card on the pipeline. */
  initialDealId?: string;
}) {
  const { subAccountId, agencyId } = useSubAccount();
  const { contacts, jobs, loaded } = useFieldData();
  const resolveStage = useDealStageResolver();
  const { hydrated: pipelinesReady } = usePipelines();
  const { ready: territoryReady, filter: territoryFilter } = useEffectiveTerritoryFilter();
  const territoryKey = JSON.stringify(territoryFilter ?? null);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [dealId, setDealId] = useState("");
  const appliedDeal = useRef("");
  const [contactId, setContactId] = useState("");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [address, setAddress] = useState<ServiceAddress>(EMPTY_ADDRESS);
  const [lines, setLines] = useState<JobLineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [currency, setCurrency] = useState("USD");
  const { config } = useFieldConfig();
  const wsCur = workspaceCurrencyOf(config);
  const terms = jobTerms(config);
  const [billingType, setBillingType] = useState<JobBillingType | null>(null);
  const [timers, setTimers] = useState(false);
  const [hoursOnly, setHoursOnly] = useState(false);
  const { services: catalog, workers } = useFieldData();
  const [workerIds, setWorkerIds] = useState<string[]>([]);
  const [visitStart, setVisitStart] = useState("");
  const [visitMinutes, setVisitMinutes] = useState(60);
  const [visitTz, setVisitTz] = useState("");
  const [visitTouched, setVisitTouched] = useState(false);
  const [lengthTouched, setLengthTouched] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const fromServices = billingFromServices(
    lines.flatMap((l) => {
      const svc = l.productId ? catalog.find((p) => p.id === l.productId) : undefined;
      return svc ? [svc] : [];
    }),
  );
  const chosenBilling = billingType ?? fromServices ?? config?.defaultBillingType ?? "time_and_materials";
  const estimateMode = config?.timesheetsEnabled === true && chosenBilling === "time_and_materials";
  const fixed = chosenBilling === "lump_sum";
  const hasService = lines.some((l) => l.productId && catalog.some((p) => p.id === l.productId));
  const allowance = jobAllowanceMinutes(lines, catalog);
  const travelAllowance = Math.max(0, ...lines.map((l) => catalog.find((p) => p.id === l.productId)?.travelMinutes ?? 0));
  const wt = workerTerms(config);

  // A fixed price project starts with its first visit: the length follows the services, the time is the next open slot.
  useEffect(() => {
    if (!lengthTouched) setVisitMinutes(allowance || 60);
  }, [allowance, lengthTouched]);

  useEffect(() => {
    if (!open || !fixed || !hasService || workerIds.length === 0 || visitTouched) return;
    let live = true;
    setSuggesting(true);
    void callApi<{ start: string | null; timezone: string }>(
      `/api/sub-accounts/${subAccountId}/field-services/jobs/first-slot`,
      "POST",
      { workerIds, minutes: visitMinutes, travelMinutes: travelAllowance },
    ).then((res) => {
      if (!live) return;
      setSuggesting(false);
      if (!res) return;
      setVisitTz(res.timezone);
      setVisitStart(res.start ? utcToZonedInput(new Date(res.start), res.timezone) : "");
    });
    return () => {
      live = false;
    };
  }, [open, fixed, hasService, workerIds, visitMinutes, travelAllowance, visitTouched, subAccountId]);

  const contact = contacts.find((c) => c.id === contactId);
  const saved = contact?.serviceAddresses ?? [];

  useEffect(() => {
    if (!open || !agencyId || !territoryReady) return;
    return subscribeToDeals({ agencyId, subAccountId }, { territoryFilter }, setDeals, () => setDeals([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agencyId, subAccountId, territoryReady, territoryKey]);

  // Closing for any reason, not only after saving, clears what a deal filled in.
  useEffect(() => {
    if (open) return;
    setContactId("");
    setDealId("");
    appliedDeal.current = "";
    setTitle("");
    setNotes("");
    setBillingType(null);
    setWorkerIds([]);
    setVisitStart("");
    setVisitTouched(false);
    setLengthTouched(false);
    setTimers(false);
    setAddress(EMPTY_ADDRESS);
    setLines([]);
    setCurrency(wsCur);
    setDeals(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const usedDeals = useMemo(
    () => new Set(jobs.filter((j) => j.dealId && j.status !== "cancelled").map((j) => j.dealId as string)),
    [jobs],
  );
  const wonDeals = useMemo(
    () => (deals ?? []).filter((d) => resolveStage(d).terminal === "won" && !usedDeals.has(d.id)),
    [deals, usedDeals, resolveStage],
  );

  function pickDeal(id: string) {
    const deal = wonDeals.find((d) => d.id === id);
    if (!deal) {
      setDealId("");
      return;
    }
    setDealId(deal.id);
    setContactId(deal.contactId);
    setTitle(deal.title);
    setCurrency(wsCur);
    setLines(
      deal.value > 0
        ? [
            {
              id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
              description: deal.title,
              quantity: 1,
              unitPriceMinor: unitToMinor(wsCur, deal.value),
            },
          ]
        : [],
    );
  }

  useEffect(() => {
    // Wait for everything the answer depends on, or a valid deal looks unusable for a moment.
    if (!open || !initialDealId || deals === null || !pipelinesReady || !loaded) return;
    if (appliedDeal.current === initialDealId) return;
    appliedDeal.current = initialDealId;
    if (wonDeals.some((d) => d.id === initialDealId)) pickDeal(initialDealId);
    else toast.error("That deal can't start a project. It may already have one.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialDealId, deals, wonDeals, pipelinesReady, loaded]);

  async function submit() {
    setBusy(true);
    const res = await callApi<{ id: string; number: string; visitError?: string; warnings?: string[] }>(
      `/api/sub-accounts/${subAccountId}/field-services/jobs`,
      "POST",
      {
        contactId,
        ...(dealId ? { dealId } : {}),
        title,
        description: notes,
        serviceAddress: addressIsEmpty(address) ? null : address,
        // On a Time and materials project the lines are the internal estimate, not charges.
        ...(estimateMode ? { estimateLines: lines } : { lineItems: lines }),
        currency,
        ...(config?.timesheetsEnabled ? { billingType: chosenBilling } : {}),
        workerIds,
        ...(fixed && visitStart && visitTz
          ? { firstVisit: { start: zonedTimeToUtc(visitStart, visitTz).toISOString(), minutes: visitMinutes } }
          : {}),
        timersEnabled: timers && !hoursOnly,
        ...(config?.timesheetsEnabled && hoursOnly ? { hoursOnly: true } : {}),
      },
    );
    setBusy(false);
    if (!res) return;
    toast.success(`${terms.Job} ${res.number} created.`);
    if (res.visitError) toast.warning(`The first visit wasn't booked: ${res.visitError} Schedule it from the project.`);
    for (const w of res.warnings ?? []) toast.warning(w);
    onOpenChange(false);
    onCreated(res.id);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New {terms.job}</DialogTitle>
          <DialogDescription>
            Add the customer, where the work is and what needs doing. It waits
            in the list until you schedule it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {(wonDeals.length > 0 || dealId) && (
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Start from a won deal (optional)
              </Label>
              <select
                className={SELECT_CLASS}
                value={dealId}
                disabled={busy}
                onChange={(e) => pickDeal(e.target.value)}
              >
                <option value="">Not from a deal</option>
                {wonDeals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title} · {formatCurrency(d.value, d.currency)} ·{" "}
                    {contacts.find((c) => c.id === d.contactId)?.name ?? "Customer"}
                  </option>
                ))}
              </select>
              {dealId && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Linked to the deal. The customer, title and one charge line at the deal value are filled in for you
                  to change. Marking the {terms.job} complete ticks the deal as delivered.
                </p>
              )}
            </div>
          )}
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              Customer
            </Label>
            <ContactPicker
              contacts={contacts}
              value={contactId}
              onChange={(id) => {
                setContactId(id);
                const linked = wonDeals.find((d) => d.id === dealId);
                if (linked && linked.contactId !== id) setDealId("");
              }}
              placeholder="Pick a customer…"
              title="Pick a customer"
              allowNew
            />
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              {terms.Job} title
            </Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Notes (optional)</Label>
            <Textarea
              rows={3}
              value={notes}
              maxLength={4000}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              {terms.Job}-site address
            </Label>
            {saved.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {saved.map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setAddress({ ...EMPTY_ADDRESS, ...a })}
                    className="rounded-full border px-2.5 py-1 text-xs hover:bg-muted"
                  >
                    {formatServiceAddress(a)}
                  </button>
                ))}
              </div>
            )}
            <AddressFields value={address} onChange={setAddress} disabled={busy} />
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              {wt.Workers} <span className="text-destructive">*</span>
            </Label>
            <StaffPicker
              people={workers.filter((w) => w.status === "active")}
              value={workerIds}
              onChange={setWorkerIds}
              disabled={busy}
              noun={wt.workers}
            />
          </div>
          <div className="flex flex-wrap items-end gap-4">
            {config?.timesheetsEnabled === true && (
              <div className="min-w-48 flex-1 sm:max-w-xs">
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Billing type
                </Label>
                <BillingTypeSelect
                  value={chosenBilling}
                  onChange={setBillingType}
                  disabled={busy}
                  onInternal={() => {
                    onOpenChange(false);
                    onInternal();
                  }}
                />
              </div>
            )}
            {config?.timesheetsEnabled === true && (
              <label className="flex w-full cursor-pointer items-start gap-2 text-sm">
                <Checkbox className="mt-0.5" checked={hoursOnly} onCheckedChange={(v) => setHoursOnly(v === true)} disabled={busy} />
                <span>
                  <span className="block font-medium">Hours only</span>
                  <span className="block text-xs text-muted-foreground">
                    Staff enter a date and hours, with no start or stop times, here and on invoices. It cannot be changed once time is logged, and there is no timer.
                  </span>
                </span>
              </label>
            )}
            <label className="flex w-full cursor-pointer items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={timers && !hoursOnly} onCheckedChange={(v) => setTimers(v === true)} disabled={busy || hoursOnly} />
              <span>
                <span className="block font-medium">Allow a start and stop timer</span>
                <span className="block text-xs text-muted-foreground">Off by default. Without it, staff enter their hours on the Time tab, which needs timesheets switched on in Settings.</span>
              </span>
            </label>
          </div>
          {config?.timesheetsEnabled === true && (
            <p className="-mt-2 text-xs text-muted-foreground">{billingTypeHints(terms)[chosenBilling]}</p>
          )}
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              {estimateMode ? "Estimate (description, quantity, price). Internal, never billed" : "What you will charge for (description, quantity, price)"}
            </Label>
            <LinesEditor currency={currency} lines={lines} onChange={setLines} disabled={busy} estimate={estimateMode} />
          </div>
          {fixed && !hasService && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
              A fixed price {terms.job} must be linked to a service. Add a service line above.
            </p>
          )}
          {fixed && hasService && workerIds.length > 0 && (
            <div className="rounded-lg border p-3">
              <p className="text-sm font-medium">First visit</p>
              <p className="mb-2 text-xs text-muted-foreground">
                {suggesting
                  ? "Finding the next open time…"
                  : "Booked when you create the project, at the next time everyone chosen is free. Change it if you like. The staff are told."}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Start{visitTz ? ` (${visitTz})` : ""}
                  </Label>
                  <Input
                    type="datetime-local"
                    value={visitStart}
                    disabled={busy}
                    onChange={(e) => {
                      setVisitStart(e.target.value);
                      setVisitTouched(true);
                    }}
                  />
                </div>
                <div>
                  <Label className="mb-1 block text-xs font-medium text-muted-foreground">Length (minutes)</Label>
                  <Input
                    inputMode="numeric"
                    value={String(visitMinutes)}
                    disabled={busy}
                    onChange={(e) => {
                      setVisitMinutes(Math.max(15, Number(e.target.value.replace(/\D/g, "")) || 60));
                      setLengthTouched(true);
                    }}
                  />
                </div>
              </div>
              {visitTouched && (
                <button
                  type="button"
                  className="mt-2 text-xs text-primary underline-offset-2 hover:underline"
                  onClick={() => setVisitTouched(false)}
                >
                  Suggest the next open time again
                </button>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || !contactId || !title.trim() || workerIds.length === 0 || (fixed && (!hasService || !visitStart))}
          >
            Create {terms.job}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function JobsTab({ onOpenJob, initialFilter }: { onOpenJob: (jobId: string) => void; initialFilter?: Filter }) {
  const { jobs, loaded, workers } = useFieldData();
  const { isAdmin } = useSubAccount();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const [filter, setFilter] = useState<Filter>(initialFilter ?? "active");
  const [creating, setCreating] = useState(false);
  const [prefillDeal, setPrefillDeal] = useState("");
  const [running, setRunning] = useState(false);
  const [newInternal, setNewInternal] = useState(0);

  // The pipeline's "Create project" shortcut arrives here with the deal in the address.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("newProject");
    if (!id) return;
    setPrefillDeal(id);
    setCreating(true);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const shown = useMemo(() => jobs.filter((j) => matches(filter, j)), [jobs, filter]);

  return (
    <div className="space-y-6">
    <section className="rounded-2xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{terms.Jobs}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Work you have agreed to do. {withArticle(terms.job).replace(/^./, (c) => c.toUpperCase())} can have several visits.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isAdmin && config?.timesheetsEnabled === true && (
            <Button variant="outline" onClick={() => setRunning(true)}>
              Invoice run
            </Button>
          )}
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-2 h-4 w-4" /> New {terms.job}
          </Button>
        </div>
      </div>
      <InvoiceRunDialog open={running} onOpenChange={setRunning} />

      <div className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium " +
              (filter === f.id ? "border-primary bg-primary/10" : "hover:bg-muted")
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {!loaded ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No {terms.jobs} here yet.</p>
      ) : (
        <ul className="mt-4 divide-y rounded-lg border">
          {shown.map((j) => {
            const kind = config?.timesheetsEnabled ? PROJECT_KIND_STYLE[projectKindOf(j)] : null;
            return (
            <li key={j.id} className={kind ? "border-l-4 " + kind.edge + " " + kind.tint : ""}>
              <button
                onClick={() => onOpenJob(j.id)}
                className="flex w-full flex-wrap items-center gap-3 p-3 text-left hover:bg-muted/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="text-muted-foreground">{j.number}</span>
                    <span className="truncate">{j.title}</span>
                    <JobStatusPill status={j.status} invoiced={isInvoiced(j)} />
                    {kind && (
                      <span className={"rounded-full px-2 py-0.5 text-[10px] font-medium " + kind.chip}>
                        {PROJECT_KIND_LABELS[projectKindOf(j)]}
                      </span>
                    )}
                    {j.dealId && (
                      <span className="text-[10px] font-normal text-muted-foreground" title="Linked to a deal on the pipeline">
                        Pipeline deal
                      </span>
                    )}
                    {j.outOfArea && (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="h-3 w-3" /> Outside your areas
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {j.contactName}
                    {j.serviceAddress ? ` · ${formatServiceAddress(j.serviceAddress)}` : ""}
                  </p>
                </div>
              </button>
            </li>
            );
          })}
        </ul>
      )}

      <NewJobDialog
        open={creating}
        onOpenChange={(o) => {
          setCreating(o);
          if (!o) setPrefillDeal("");
        }}
        onCreated={onOpenJob}
        onInternal={() => setNewInternal((n) => n + 1)}
        initialDealId={prefillDeal}
      />
    </section>
    {isAdmin && config?.timesheetsEnabled === true && <InternalJobsSection workers={workers} newSignal={newInternal} />}
    </div>
  );
}
