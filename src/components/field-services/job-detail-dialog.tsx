"use client";

import { PROJECT_KIND_LABELS, PROJECT_KIND_STYLE, projectKindOf } from "@/lib/field-services/project-kind";
import { FindTimeDialog } from "@/components/field-services/find-time-dialog";
import { utcToZonedInput } from "@/lib/field-services/time";
import { isInvoiced } from "@/lib/field-services/job-status";
import { JobNotes } from "@/components/field-services/job-notes";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Loader2, Maximize2, Pencil } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StaffPicker } from "@/components/field-services/staff-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useFieldData } from "@/components/field-services/field-data";
import { LinesEditor, type LineStaff } from "@/components/field-services/jobs-tab";
import { JobWorkSection } from "@/components/field-services/job-work-section";
import { JobCustomerSection } from "@/components/field-services/job-customer-section";
import { JobRevenueSection } from "@/components/field-services/job-revenue-section";
import { JobIssuedInvoices } from "@/components/field-services/job-issued-invoices";
import { JobContactCard } from "@/components/field-services/job-contact-card";
import { JobRepeatSection } from "@/components/field-services/job-repeat-section";
import { formatMoneyCode } from "@/lib/field-services/money";
import { formatMinutes, jobAllowanceMinutes } from "@/lib/field-services/duration";
import {
  JobStatusPill,
  SELECT_CLASS,
  VisitStatusPill,
  callApi,
} from "@/components/field-services/field-ui";
import { formatServiceAddress } from "@/lib/field-services/address";
import { formatInZone, zonedTimeToUtc } from "@/lib/field-services/time";
import { activeTimeKinds, projectActivities } from "@/lib/field-services/time-kinds";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { jobTerms, workerTerms, labourTerm, activityTerm } from "@/lib/field-services/terms";
import { VisitChecklistOffice } from "@/components/field-services/visit-checklist-office";
import { weekEndingLabel } from "@/components/field-services/invoice-run-dialog";
import { effectiveBillingType } from "@/lib/field-services/billing-type";
import type { JobBillingType, JobLineItem, VisitStatus } from "@/types/field-services";

const DURATIONS = [30, 60, 90, 120, 180, 240, 480];

function toDate(v: unknown): Date | null {
  const t = v as { toDate?: () => Date } | null | undefined;
  return t && typeof t.toDate === "function" ? t.toDate() : null;
}

const NEXT: Record<VisitStatus, { status: string; label: string }[]> = {
  pending: [
    { status: "on_my_way", label: "On the way" },
    { status: "checked_in", label: "Started" },
    { status: "completed", label: "Done" },
    { status: "no_show", label: "No-show" },
    { status: "cancelled", label: "Cancel" },
  ],
  on_my_way: [
    { status: "checked_in", label: "Started" },
    { status: "completed", label: "Done" },
    { status: "no_show", label: "No-show" },
    { status: "cancelled", label: "Cancel" },
  ],
  checked_in: [
    { status: "completed", label: "Done" },
    { status: "no_show", label: "No-show" },
    { status: "cancelled", label: "Cancel" },
  ],
  completed: [],
  no_show: [],
  cancelled: [],
};

export function JobDetailDialog({
  jobId,
  onClose,
}: {
  jobId: string | null;
  onClose: () => void;
}) {
  const { subAccountId, isAdmin, saPath } = useSubAccount();
  const { jobs, visits, workers, services } = useFieldData();
  const { config: fieldConfig } = useFieldConfig();
  const terms = jobTerms(fieldConfig);
  const wt = workerTerms(fieldConfig);
  const { user } = useAuth();
  const isOffice =
    isAdmin || !workers.some((w) => w.memberUid === user?.uid && w.status === "active");
  const job = jobs.find((j) => j.id === jobId) ?? null;
  const jobVisits = useMemo(
    () => visits.filter((v) => v.jobId === jobId),
    [visits, jobId],
  );
  const activeWorkers = workers.filter((w) => w.status === "active");
  const liveVisits = jobVisits
    .filter((v) => v.status !== "cancelled")
    .sort((a, b) => (toDate(a.scheduledStart)?.getTime() ?? 0) - (toDate(b.scheduledStart)?.getTime() ?? 0));
  const focus =
    liveVisits.find((v) => v.status !== "completed" && v.status !== "no_show") ?? liveVisits[liveVisits.length - 1] ?? null;
  const focusStart = focus ? toDate(focus.scheduledStart) : null;
  const focusEnd = focus ? toDate(focus.scheduledEnd) : null;
  const focusMinutes = focusStart && focusEnd ? Math.round((focusEnd.getTime() - focusStart.getTime()) / 60000) : 0;
  const workerName = (id: string) => workers.find((w) => w.id === id)?.name ?? `Removed ${wt.worker}`;

  const [lines, setLines] = useState<JobLineItem[]>([]);
  const [currency, setCurrency] = useState("USD");
  const [timesheetsOn, setTimesheetsOn] = useState(false);
  const [invoiceView, setInvoiceView] = useState<"create" | "issued">("create");
  const [includeTravelFee, setIncludeTravelFee] = useState(false);
  const [weekChoices, setWeekChoices] = useState<string[]>([]);
  const [weekEnding, setWeekEnding] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [billVisitId, setBillVisitId] = useState("");
  const [linesDirty, setLinesDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"scope" | "visits" | "work" | "revenue" | "invoicing" | "settings">("scope");
  const [estimate, setEstimate] = useState<JobLineItem[]>([]);
  const [estimateDirty, setEstimateDirty] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    setTab("scope");
    setShowSchedule(false);
  }, [jobId]);

  const [startLocal, setStartLocal] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [pickedWorkers, setPickedWorkers] = useState<string[]>([]);
  const jobStaffKey = job?.id ?? "";
  const jobStaff = job?.workerIds;
  useEffect(() => {
    setPickedWorkers(jobStaff ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobStaffKey]);
  // A visit for a service takes the time that service is expected to take unless someone changes it.
  const allowance = job ? jobAllowanceMinutes(job.lineItems, services) : 0;
  useEffect(() => {
    setMinutes(allowance > 0 ? allowance : 60);
  }, [job?.id, allowance]);

  useEffect(() => {
    if (job) {
      setLines(job.lineItems);
      setCurrency(job.currency);
      setLinesDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.lineItemsVersion]);

  const base = `/api/sub-accounts/${subAccountId}/field-services`;

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    fetch(`${base}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { config?: { timesheetsEnabled?: boolean } } | null) => {
        if (cancelled) return;
        setTimesheetsOn(d?.config?.timesheetsEnabled === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [jobId, base]);
  useEffect(() => {
    if (!jobId || !timesheetsOn || !isAdmin) return;
    let cancelled = false;
    fetch(`${base}/invoice-run?weeksOnly=1`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { weeks?: string[] } | null) => {
        if (!cancelled && d?.weeks) setWeekChoices(d.weeks);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [jobId, timesheetsOn, isAdmin, base]);
  const locked = job ? job.status === "closed" || job.status === "cancelled" : true;
  const billingValue: JobBillingType = job ? effectiveBillingType(job) : "time_and_materials";

  async function saveLines(): Promise<boolean> {
    if (!job) return false;
    setBusy("lines");
    const ok = await callApi(`${base}/jobs/${job.id}`, "PATCH", {
      lineItems: lines,
      lineItemsVersion: job.lineItemsVersion ?? 0,
      currency,
    });
    setBusy(null);
    if (ok) {
      setLinesDirty(false);
      setConfirmDiscard(false);
      toast.success("Lines saved.");
    }
    return !!ok;
  }

  // Time and materials: the estimate is internal. Fixed price (and workspaces without timesheets) keep charge lines.
  const estimateMode = timesheetsOn && billingValue === "time_and_materials";

  useEffect(() => {
    setEstimate(job?.estimateLines ?? []);
    setEstimateDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  // Staff sell and cost rates (admins only), so an estimate line can be priced by who does the work.
  const [staffRates, setStaffRates] = useState<LineStaff[]>([]);
  useEffect(() => {
    if (!estimateMode || !isAdmin) return;
    let cancelled = false;
    fetch(`${base}/workers/rates`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { rates: Record<string, { costRateMinor: number; sellRateMinor: number }> } | null) => {
        if (cancelled || !d) return;
        setStaffRates(
          activeWorkers
            .filter((w) => (d.rates[w.id]?.sellRateMinor ?? 0) > 0)
            .map((w) => ({
              id: w.id,
              name: w.name,
              sellMinor: d.rates[w.id].sellRateMinor,
              costMinor: d.rates[w.id].costRateMinor,
            })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateMode, isAdmin, base, workers.length, job?.id]);

  // Staff lines follow the staff member's current sell rate, unless the price was typed over.
  useEffect(() => {
    if (staffRates.length === 0) return;
    let changed = false;
    const next = estimate.map((l) => {
      const w = l.workerId && !l.priceLocked ? staffRates.find((x) => x.id === l.workerId) : undefined;
      if (w && w.sellMinor !== l.unitPriceMinor) {
        changed = true;
        return { ...l, unitPriceMinor: w.sellMinor };
      }
      return l;
    });
    if (changed) {
      setEstimate(next);
      setEstimateDirty(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffRates]);

  async function saveEstimate(): Promise<boolean> {
    if (!job) return false;
    setBusy("estimate");
    const ok = await callApi(`${base}/jobs/${job.id}`, "PATCH", { estimateLines: estimate });
    setBusy(null);
    if (ok) {
      setEstimateDirty(false);
      toast.success("Estimate saved.");
    }
    return !!ok;
  }

  async function changeShowScope(on: boolean) {
    if (!job) return;
    await callApi(`${base}/jobs/${job.id}`, "PATCH", { showScopeOnInvoice: on });
  }

  async function saveAndClose() {
    if (linesDirty && !(await saveLines())) return;
    if (estimateDirty && !(await saveEstimate())) return;
    onClose();
  }

  function closeWithoutSaving() {
    // Changes that were not saved are lost, so a second press is needed.
    if ((linesDirty || estimateDirty) && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  async function saveTitle() {
    if (!job) return;
    const next = titleDraft.trim();
    if (!next) return;
    if (next === job.title) {
      setRenaming(false);
      return;
    }
    setBusy("title");
    const ok = await callApi(`${base}/jobs/${job.id}`, "PATCH", { title: next });
    setBusy(null);
    if (ok) {
      setRenaming(false);
      toast.success("Name saved.");
    }
  }

  async function saveDetails() {
    if (!job) return;
    setBusy("details");
    const ok = await callApi(`${base}/jobs/${job.id}`, "PATCH", { description: detailsDraft });
    setBusy(null);
    if (ok) {
      setEditingDetails(false);
      toast.success("Details saved.");
    }
  }

  async function changeActivities(ids: string[]) {
    if (!job) return;
    setBusy("activities");
    await callApi(`${base}/jobs/${job.id}`, "PATCH", { activityIds: ids });
    setBusy(null);
  }

  async function changeTimers(on: boolean) {
    if (!job) return;
    setBusy("timers");
    await callApi(`${base}/jobs/${job.id}`, "PATCH", { timersEnabled: on });
    setBusy(null);
  }

  async function changeHoursOnly(on: boolean) {
    if (!job) return;
    setBusy("hoursOnly");
    await callApi(`${base}/jobs/${job.id}`, "PATCH", { hoursOnly: on });
    setBusy(null);
  }

  async function schedule() {
    if (!job || !startLocal) return;
    const start = zonedTimeToUtc(startLocal, job.timezone);
    if (Number.isNaN(start.getTime())) {
      toast.error("Pick a start date and time.");
      return;
    }
    setBusy("visit");
    const res = await callApi<{ warnings?: string[] }>(`${base}/jobs/${job.id}/visits`, "POST", {
      scheduledStart: start.toISOString(),
      durationMinutes: minutes,
      workerIds: pickedWorkers,
    });
    setBusy(null);
    if (!res) return;
    toast.success("Visit scheduled.");
    for (const w of res.warnings ?? []) toast.warning(w);
    setStartLocal("");
  }

  async function setStatus(visitId: string, status: string) {
    setBusy(visitId);
    await callApi(`${base}/visits/${visitId}/status`, "POST", { status });
    setBusy(null);
  }

  const showWeeks =
    timesheetsOn && weekChoices.length > 0 && (billingValue === "time_and_materials" || billingValue === "day_rate");

  // Revenue and Time & parts can open in a larger window, easier to read on a big project.
  const [expanded, setExpanded] = useState<"revenue" | "work" | null>(null);
  // The invoice preview is the customer's PDF, made without saving anything.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewWarn, setPreviewWarn] = useState({ hours: 0, parts: 0 });

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function closePreview() {
    setPreviewUrl(null);
  }

  async function previewInvoice() {
    if (!job) return;
    if (job.jobType === "recurring" && !billVisitId) {
      toast.error("Choose which finished visit to bill.");
      return;
    }
    setBusy("preview");
    try {
      const res = await fetch(`${base}/jobs/${job.id}/invoice-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(includeTravelFee && job.travelFeeCents ? { includeTravelFee } : {}),
          ...(weekEnding && showWeeks ? { weekEnding, weeks: 0 } : {}),
          ...(billVisitId ? { visitId: billVisitId } : {}),
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(err.error ?? "The preview could not be made.");
        return;
      }
      const blob = await res.blob();
      setPreviewWarn({
        hours: Number(res.headers.get("X-Hours-Waiting")) || 0,
        parts: Number(res.headers.get("X-Parts-Unpriced")) || 0,
      });
      setPreviewUrl(URL.createObjectURL(blob));
    } catch {
      toast.error("The preview could not be made.");
    } finally {
      setBusy(null);
    }
  }

  async function draft(kind: "quote" | "invoice") {
    if (!job) return;
    setBusy(kind);
    if (kind === "invoice" && job.jobType === "recurring" && !billVisitId) {
      toast.error("Choose which finished visit to bill.");
      setBusy(null);
      return;
    }
    const res = await callApi<{
      id: string;
      quoteNumber: string;
      partsBilled?: number;
      hoursBilled?: number;
      hoursWaiting?: number;
      partsUnpriced?: number;
    }>(`${base}/jobs/${job.id}/documents`, "POST", {
      kind,
      ...(kind === "invoice"
        ? {
            ...(includeTravelFee && job.travelFeeCents ? { includeTravelFee } : {}),
            ...(weekEnding && showWeeks ? { weekEnding, weeks: 0 } : {}),
            ...(billVisitId ? { visitId: billVisitId } : {}),
          }
        : {}),
    });
    setBusy(null);
    if (res) {
      const extra =
        kind === "invoice" && (res.hoursBilled || res.partsBilled)
          ? ` It includes ${res.hoursBilled ?? 0} hours and ${res.partsBilled ?? 0} parts.`
          : "";
      toast.success(`${kind === "invoice" ? "Invoice" : "Estimate"} ${res.quoteNumber} drafted.${extra} Review it before sending.`);
      if (kind === "invoice" && res.partsUnpriced) {
        toast.warning(
          `${res.partsUnpriced} part${res.partsUnpriced === 1 ? " was" : "s were"} left off because ${res.partsUnpriced === 1 ? "it has" : "they have"} no price. Add a price in the parts list, then draft another invoice.`,
        );
      }
      if (kind === "invoice" && res.hoursWaiting) {
        toast.warning(
          `${res.hoursWaiting} logged hours were left off because their week isn't approved yet. Approve it on the Timesheets tab and draft another invoice.`,
        );
      }
      if (kind === "invoice") setBillVisitId("");
    }
  }

  async function remove() {
    if (!job) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy("delete");
    const ok = await callApi(`${base}/jobs/${job.id}`, "DELETE");
    setBusy(null);
    setConfirmDelete(false);
    if (ok) {
      toast.success(`${terms.Job} deleted.`);
      onClose();
    }
  }

  async function action(a: "close" | "cancel" | "reopen") {
    if (!job) return;
    setBusy(a);
    const ok = await callApi(`${base}/jobs/${job.id}/actions`, "POST", { action: a });
    setBusy(null);
    if (ok) toast.success(a === "close" ? `${terms.Job} closed.` : a === "reopen" ? `${terms.Job} reopened.` : `${terms.Job} cancelled.`);
  }

  const tabs: { id: "scope" | "visits" | "work" | "revenue" | "invoicing" | "settings"; label: string }[] = [
    { id: "scope", label: "Scope" },
    { id: "visits", label: jobVisits.length > 0 ? `Visits (${jobVisits.length})` : "Visits" },
    { id: "work", label: "Time & parts" },
    { id: "revenue", label: "Revenue" },
    { id: "invoicing", label: "Invoicing" },
    ...(isOffice || isAdmin ? [{ id: "settings" as const, label: "Settings" }] : []),
  ];

  return (
    <Dialog open={jobId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          "flex max-h-[90vh] flex-col gap-4 overflow-hidden sm:h-[90vh] sm:max-w-3xl",
          job && fieldConfig?.timesheetsEnabled && "border-l-4 " + PROJECT_KIND_STYLE[projectKindOf(job)].edge,
        )}
      >
        {!job ? (
          <DialogHeader>
            <DialogTitle>{terms.Job}</DialogTitle>
            <DialogDescription>Loading…</DialogDescription>
          </DialogHeader>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                {job.title}
                {isAdmin && !locked && (
                  <button
                    type="button"
                    aria-label={`Rename ${terms.job}`}
                    title={`Rename this ${terms.job}`}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => {
                      setTitleDraft(job.title);
                      setRenaming(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
                <JobStatusPill status={job.status} invoiced={isInvoiced(job)} />
                {fieldConfig?.timesheetsEnabled && (
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-[10px] font-medium " + PROJECT_KIND_STYLE[projectKindOf(job)].chip
                    }
                  >
                    {PROJECT_KIND_LABELS[projectKindOf(job)]}
                  </span>
                )}
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground" title="Set when the project was created">
                  {job.currency}
                </span>
              </DialogTitle>
              <DialogDescription>
                {job.number}
                {!isOffice && (
                  <>
                    {" · "}
                    <Link href={saPath(`/contacts/${job.contactId}`)} className="underline-offset-2 hover:underline">
                      {job.contactName}
                    </Link>
                    {job.serviceAddress ? ` · ${formatServiceAddress(job.serviceAddress)}` : ""}
                  </>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="-mx-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-4">
            {renaming && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={titleDraft}
                  maxLength={200}
                  autoFocus
                  aria-label={`${terms.Job} name`}
                  className="min-w-0 flex-1"
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveTitle();
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
                <Button size="sm" disabled={busy === "title" || !titleDraft.trim()} onClick={() => void saveTitle()}>
                  Save name
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRenaming(false)}>
                  Cancel
                </Button>
              </div>
            )}

            <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">When</p>
                {focus ? (
                  <>
                    <p className="text-sm font-semibold">
                      {focusStart
                        ? formatInZone(focusStart, job.timezone, {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "numeric",
                            minute: "2-digit",
                          })
                        : "—"}
                      {focusMinutes > 0 ? <span className="font-normal text-muted-foreground">{" · "}{formatMinutes(focusMinutes)}</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {liveVisits.length > 1 ? `${liveVisits.length} visits · ` : ""}
                      <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setTab("visits")}>
                        {liveVisits.length > 1 ? "See all" : "Open visit"}
                      </button>
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Not scheduled.{" "}
                    {!locked && (
                      <button
                        type="button"
                        className="text-primary underline-offset-2 hover:underline"
                        onClick={() => {
                          setTab("visits");
                          setShowSchedule(true);
                        }}
                      >
                        Schedule a visit
                      </button>
                    )}
                  </p>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{wt.Workers}</p>
                {focus && focus.workerIds.length > 0 ? (
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    {focus.workerIds.map((id) => (
                      <span key={id} className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium">
                        {workerName(id)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{focus ? "Unassigned" : "None yet"}</p>
                )}
              </div>
            </div>

            {isOffice && <JobContactCard job={job} />}

            <div className="flex flex-wrap gap-1 border-b">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
                    tab === t.id
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="space-y-6">
              {tab === "visits" && (
                <section>
                {jobVisits.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No visits scheduled yet.</p>
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {jobVisits.map((v) => {
                      const start = toDate(v.scheduledStart);
                      return (
                        <li key={v.id} className="space-y-2 p-3">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-medium">
                              {start
                                ? formatInZone(start, job.timezone, {
                                    weekday: "short",
                                    day: "numeric",
                                    month: "short",
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })
                                : "—"}
                            </span>
                            <VisitStatusPill status={v.status} manyVisits={jobVisits.filter((x) => x.status !== "cancelled").length > 1} />
                            <span className="text-xs text-muted-foreground">
                              {v.workerIds.length
                                ? v.workerIds.map(workerName).join(", ")
                                : "Unassigned"}
                            </span>
                          </div>
                          <VisitChecklistOffice visit={v} base={base} />
                          {NEXT[v.status].length > 0 && (
                            <div className="space-y-1.5">
                              <p className="text-xs text-muted-foreground">Change this visit&apos;s status</p>
                              <div className="flex flex-wrap gap-2">
                                {NEXT[v.status]
                                  .filter((n) => isOffice || n.status !== "cancelled")
                                  .map((n) => (
                                    <Button
                                      key={n.status}
                                      size="sm"
                                      variant="outline"
                                      className={
                                        n.status === "completed"
                                          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                                          : undefined
                                      }
                                      disabled={busy === v.id}
                                      onClick={() => void setStatus(v.id, n.status)}
                                    >
                                      {n.label}
                                    </Button>
                                  ))}
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                  {!locked && !showSchedule && jobVisits.length > 0 && (
                    <Button className="mt-3" variant="outline" size="sm" onClick={() => setShowSchedule(true)}>
                      + Schedule another visit
                    </Button>
                  )}
                  {!locked && (showSchedule || jobVisits.length === 0) && (
                  <div className="mt-3 grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
                    <div>
                      <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Start ({job.timezone})
                      </Label>
                      <Input
                        type="datetime-local"
                        value={startLocal}
                        onChange={(e) => setStartLocal(e.target.value)}
                      />
                      <Button type="button" variant="link" size="sm" className="h-auto px-0 pt-1" onClick={() => setFinding(true)}>
                        Find a time
                      </Button>
                    </div>
                    <div>
                      <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Length
                      </Label>
                      <select
                        className={SELECT_CLASS}
                        value={minutes}
                        onChange={(e) => setMinutes(Number(e.target.value))}
                      >
                        {[...new Set([...DURATIONS, ...(allowance > 0 ? [allowance] : []), minutes])]
                          .sort((a, b) => a - b)
                          .map((d) => (
                            <option key={d} value={d}>
                              {formatMinutes(d)}
                              {d === allowance ? " (this service's time allowance)" : ""}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div>
                      <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                        {wt.Workers}
                      </Label>
                      <StaffPicker
                        people={activeWorkers}
                        value={pickedWorkers}
                        onChange={setPickedWorkers}
                        noun={wt.workers}
                        empty={`Add ${wt.workers} first (${labourTerm(fieldConfig)} tab). It can stay unassigned.`}
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <FindTimeDialog
                        open={finding}
                        onClose={() => setFinding(false)}
                        jobId={job.id}
                        timezone={job.timezone}
                        minutes={minutes}
                        workerIds={pickedWorkers}
                        onPick={(p) => {
                          setStartLocal(utcToZonedInput(new Date(p.startIso), job.timezone));
                          if (pickedWorkers.length === 0) setPickedWorkers(p.workerIds);
                        }}
                      />
                      <Button onClick={schedule} disabled={busy === "visit" || !startLocal}>
                        {busy === "visit" && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                        Schedule visit
                      </Button>
                    </div>
                  </div>
                  )}
                </section>
              )}

              {tab === "work" && (
                <>
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => setExpanded("work")}>
                      <Maximize2 className="mr-1.5 h-3.5 w-3.5" /> Open larger
                    </Button>
                  </div>
                  <JobWorkSection
                    job={job}
                    workers={workers}
                    isOffice={isOffice}
                    refreshKey={jobVisits.map((v) => v.id + v.status).join(",")}
                  />
                </>
              )}

              {tab === "scope" && (
                <>
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Description of project</h3>
            {editingDetails ? (
              <div className="space-y-2">
                <Textarea
                  value={detailsDraft}
                  maxLength={4000}
                  rows={5}
                  aria-label={`${terms.Job} details`}
                  onChange={(e) => setDetailsDraft(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy === "details"} onClick={() => void saveDetails()}>
                    Save details
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingDetails(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              (job.description || (isAdmin && !locked)) && (
                <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-sm">
                  <p className="min-w-0 flex-1 whitespace-pre-wrap">
                    {job.description || <span className="text-muted-foreground">No details yet.</span>}
                  </p>
                  {isAdmin && !locked && (
                    <button
                      type="button"
                      aria-label={`Edit ${terms.job} details`}
                      title="Edit details"
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => {
                        setDetailsDraft(job.description ?? "");
                        setEditingDetails(true);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )
            )}
                  </section>

                  {estimateMode ? (
                    <section>
                      <h3 className="mb-1 text-sm font-semibold">Estimate</h3>
                      <p className="mb-2 text-xs text-muted-foreground">
                        What you expect this {terms.job} to cost. It is for you and for the estimate you send the customer. Invoices bill the
                        actual time and parts, never the estimate.
                      </p>
                      <LinesEditor
                        currency={currency}
                        lines={estimate}
                        onChange={(next) => {
                          setEstimate(next);
                          setEstimateDirty(true);
                        }}
                        disabled={locked || busy === "estimate"}
                        staff={staffRates.length > 0 ? staffRates : undefined}
                        activities={projectActivities(fieldConfig?.timeKinds, job)}
                        estimate
                      />
                      {staffRates.length > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Pick a {wt.worker} and the quantity is their hours: the price comes from their sell rate.
                        </p>
                      )}
                      {estimate.some((l) => l.workerId && staffRates.some((w) => w.id === l.workerId)) && (
                        <p className="mt-2 text-sm tabular-nums text-muted-foreground">
                          Staff cost{" "}
                          {formatMoneyCode(
                            currency,
                            estimate.reduce(
                              (n, l) => n + Math.round(l.quantity * (staffRates.find((w) => w.id === l.workerId)?.costMinor ?? 0)),
                              0,
                            ),
                          )}{" "}
                          (internal, never shown to the customer)
                        </p>
                      )}
                      {estimateDirty && (
                        <Button className="mt-2" size="sm" onClick={() => void saveEstimate()} disabled={busy === "estimate"}>
                          Save estimate
                        </Button>
                      )}
                      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
                        <Checkbox
                          className="mt-0.5"
                          checked={job.showScopeOnInvoice === true}
                          onCheckedChange={(v) => void changeShowScope(v === true)}
                        />
                        <span>
                          <span className="block font-medium">Show on invoice</span>
                          <span className="block text-xs text-muted-foreground">
                            Adds the description and estimate to the invoice notes as information. They are never charged.
                          </span>
                        </span>
                      </label>
                      {job.lineItems.some((l) => !l.approvalId) && (
                        <div className="mt-4">
                          <p className="mb-1 text-xs font-medium text-muted-foreground">Charges already on this {terms.job} (billed on invoices)</p>
                          <ul className="divide-y rounded-lg border text-sm">
                            {job.lineItems
                              .filter((l) => !l.approvalId)
                              .map((l) => (
                                <li key={l.id} className="flex items-center justify-between gap-3 p-2">
                                  <span>
                                    {l.description}
                                    {l.quantity !== 1 ? ` x ${l.quantity}` : ""}
                                  </span>
                                  <span className="tabular-nums">{formatMoneyCode(currency, Math.round(l.quantity * l.unitPriceMinor))}</span>
                                </li>
                              ))}
                          </ul>
                        </div>
                      )}
                    </section>
                  ) : (
              <section>
                <h3 className="mb-2 text-sm font-semibold">What you will charge for</h3>
                <LinesEditor
                  currency={currency}
                  lines={lines}
                  onChange={(next) => {
                    setLines(next);
                    setLinesDirty(true);
                  }}
                  disabled={locked || busy === "lines"}
                />
                {linesDirty && (
                  <Button className="mt-2" size="sm" onClick={saveLines} disabled={busy === "lines"}>
                    Save lines
                  </Button>
                )}
              </section>
                  )}

                  {isOffice && <JobCustomerSection job={job} />}

                  <JobNotes
              notes={(job.notes ?? []).map((n) => ({
                id: n.id,
                text: n.text,
                byName: n.byName,
                createdAtMs: n.createdAtMs,
                editedAtMs: n.editedAtMs ?? null,
                canEdit: true,
              }))}
              onChange={async (change) => !!(await callApi(`${base}/jobs/${job.id}/notes`, "POST", change))}
            />
                </>
              )}

              {tab === "revenue" && isOffice && (
                <>
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => setExpanded("revenue")}>
                      <Maximize2 className="mr-1.5 h-3.5 w-3.5" /> Open larger
                    </Button>
                  </div>
                  <JobRevenueSection job={job} refreshKey={jobVisits.map((v) => v.id + v.status).join(",")} />
                </>
              )}

              {tab === "invoicing" && (
                <section className="space-y-4">
                  <div className="flex gap-1 border-b">
                    {(
                      [
                        ["create", "Create invoice"],
                        ["issued", "Issued invoices"],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setInvoiceView(id)}
                        className={cn(
                          "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
                          invoiceView === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {invoiceView === "issued" ? (
                    <JobIssuedInvoices job={job} />
                  ) : (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        An invoice always includes the billable time and parts that have not been invoiced yet. To leave something off,
                        move it to a non-billable activity. Nothing is sent or billed until you send it.{" "}
                        <button type="button" className="font-medium text-foreground underline" onClick={() => setTab("revenue")}>
                          See what will be invoiced on the Revenue tab
                        </button>
                        .
                      </p>
                      <div className="flex flex-wrap items-end gap-4 rounded-lg border p-3">
                        {showWeeks && (
                          <div>
                            <Label className="mb-1 block text-xs text-muted-foreground">Bill time up to</Label>
                            <select className={SELECT_CLASS} value={weekEnding} onChange={(e) => setWeekEnding(e.target.value)}>
                              <option value="">All approved time</option>
                              {weekChoices.map((w) => (
                                <option key={w} value={w}>
                                  {weekEndingLabel(w)}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {job.jobType === "recurring" && (
                          <div>
                            <Label className="mb-1 block text-xs text-muted-foreground">Visit to bill</Label>
                            <select className={SELECT_CLASS} value={billVisitId} onChange={(e) => setBillVisitId(e.target.value)}>
                              <option value="">Choose a finished visit…</option>
                              {jobVisits
                                .filter((v) => v.status === "completed")
                                .sort((x, y) => (toDate(y.scheduledStart)?.getTime() ?? 0) - (toDate(x.scheduledStart)?.getTime() ?? 0))
                                .map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {toDate(v.scheduledStart)?.toLocaleDateString(undefined, {
                                      timeZone: job.timezone,
                                      weekday: "short",
                                      day: "numeric",
                                      month: "short",
                                    }) ?? v.id}
                                    {v.invoiceId ? " (invoiced)" : ""}
                                  </option>
                                ))}
                            </select>
                          </div>
                        )}
                        {!!job.travelFeeCents && job.travelFeeCents > 0 && !job.travelFeeInvoiceId && (
                          <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm">
                            <Checkbox checked={includeTravelFee} onCheckedChange={(v) => setIncludeTravelFee(v === true)} />
                            Add the travel fee ({formatMoneyCode(currency, job.travelFeeCents)})
                          </label>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={job.status === "cancelled" || busy === "preview"}
                          onClick={() => void previewInvoice()}
                        >
                          Invoice preview
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={job.status === "cancelled" || busy === "invoice"}
                          onClick={() => void draft("invoice")}
                        >
                          Draft invoice
                        </Button>
                      </div>
                      <Dialog open={previewUrl !== null} onOpenChange={(o) => !o && closePreview()}>
                        <DialogContent className="flex h-[95vh] max-h-[95vh] flex-col gap-3 sm:max-w-4xl">
                          <DialogHeader>
                            <DialogTitle>Invoice preview</DialogTitle>
                            <DialogDescription>
                              This is the invoice your customer would receive. Nothing is saved or billed.
                            </DialogDescription>
                          </DialogHeader>
                          {previewWarn.hours > 0 && (
                            <p className="text-xs text-amber-700 dark:text-amber-400">
                              {previewWarn.hours} logged hours are left off because their week is not approved yet.
                            </p>
                          )}
                          {previewWarn.parts > 0 && (
                            <p className="text-xs text-amber-700 dark:text-amber-400">
                              {previewWarn.parts} part{previewWarn.parts === 1 ? " is" : "s are"} left off because{" "}
                              {previewWarn.parts === 1 ? "it has" : "they have"} no price.
                            </p>
                          )}
                          {previewUrl && <iframe src={previewUrl} title="Invoice preview" className="min-h-0 w-full flex-1 rounded-md border bg-white" />}
                          <DialogFooter>
                            <Button variant="outline" onClick={closePreview}>
                              Close
                            </Button>
                            <Button
                              disabled={busy === "invoice"}
                              onClick={() => {
                                closePreview();
                                void draft("invoice");
                              }}
                            >
                              Create draft invoice
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>
                  )}
                </section>
              )}

              {tab === "settings" && (isOffice || isAdmin) && (
                <>
              {isOffice && timesheetsOn && !locked && (
                <section>
                  <h3 className="mb-1 text-sm font-semibold">{activityTerm(fieldConfig)} on this {terms.job}</h3>
                  <p className="mb-2 text-xs text-muted-foreground">
                    What {wt.workers} can book time to on this {terms.job}. The list is set up in Settings; new projects start with its defaults.
                  </p>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {activeTimeKinds(fieldConfig?.timeKinds).map((k) => {
                      const on = projectActivities(fieldConfig?.timeKinds, job).some((x) => x.id === k.id);
                      const count = projectActivities(fieldConfig?.timeKinds, job).length;
                      return (
                        <label key={k.id} className="flex cursor-pointer items-center gap-2 text-sm">
                          <Checkbox
                            checked={on}
                            disabled={busy === "activities" || (on && count <= 1)}
                            onCheckedChange={(v) => {
                              const cur = projectActivities(fieldConfig?.timeKinds, job).map((x) => x.id);
                              void changeActivities(v === true ? [...cur, k.id] : cur.filter((id) => id !== k.id));
                            }}
                          />
                          {k.label}
                        </label>
                      );
                    })}
                  </div>
                </section>
              )}

              {isOffice && timesheetsOn && !locked && (
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={job.hoursOnly === true}
                    disabled={busy === "hoursOnly"}
                    onCheckedChange={(v) => void changeHoursOnly(v === true)}
                  />
                  <span>
                    <span className="block font-medium">Hours only</span>
                    <span className="block text-xs text-muted-foreground">
                      {wt.Workers} enter a date and hours, with no start or stop times, here and on invoices. It cannot be
                      changed once time is logged.
                    </span>
                  </span>
                </label>
              )}

              {isOffice && !locked && job.hoursOnly !== true && (
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={job.timersEnabled === true}
                    disabled={busy === "timers"}
                    onCheckedChange={(v) => void changeTimers(v === true)}
                  />
                  <span>
                    <span className="block font-medium">Allow a start and stop timer</span>
                    <span className="block text-xs text-muted-foreground">
                      Off by default. Without it, {wt.workers} just enter their hours on this {terms.job}.
                    </span>
                  </span>
                </label>
              )}

                  {isOffice && <JobRepeatSection key={job.id} job={job} />}

            {isAdmin && job.invoiceIds.length === 0 && !job.quoteId && (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === "delete"}
                  onClick={() => void remove()}
                >
                  {confirmDelete ? `Tap again to delete the ${terms.job} and its records` : `Delete ${terms.job}`}
                </Button>
              </div>
            )}
            {isAdmin && job.status !== "cancelled" && (
              <div className="space-y-3 rounded-lg border p-3">
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={job.status === "closed"}
                    disabled={busy === "close" || busy === "reopen"}
                    onCheckedChange={(v) => void action(v === true ? "close" : "reopen")}
                  />
                  <span>
                    <span className="font-medium">{terms.Job} closed</span>
                    <span className="block text-xs text-muted-foreground">
                      Tick when the work is finished and billed. A closed {terms.job} takes no new visits, time or expenses and
                      is hidden from the crew app. Untick to reopen it.
                    </span>
                  </span>
                </label>
                {!locked && (
                  <Button variant="outline" size="sm" disabled={busy === "cancel"} onClick={() => void action("cancel")}>
                    Call off this {terms.job}
                  </Button>
                )}
              </div>
            )}
                </>
              )}
            </div>
            </div>

            <DialogFooter className="sm:justify-between">
              <Button variant="outline" onClick={closeWithoutSaving}>
                {confirmDiscard ? "Discard unsaved changes" : "Close"}
              </Button>
              <Button disabled={busy === "lines"} onClick={() => void saveAndClose()}>
                Save &amp; close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
      {job && (
        <Dialog open={expanded !== null} onOpenChange={(o) => !o && setExpanded(null)}>
          <DialogContent className="flex h-[95vh] max-h-[95vh] flex-col gap-4 sm:max-w-6xl">
            <DialogHeader>
              <DialogTitle>
                {job.title} · {expanded === "revenue" ? "Revenue" : "Time & parts"}
              </DialogTitle>
              <DialogDescription className="sr-only">A larger view of this {terms.job}.</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {expanded === "revenue" && isOffice && (
                <JobRevenueSection job={job} refreshKey={jobVisits.map((v) => v.id + v.status).join(",")} />
              )}
              {expanded === "work" && (
                <JobWorkSection
                  job={job}
                  workers={workers}
                  isOffice={isOffice}
                  refreshKey={jobVisits.map((v) => v.id + v.status).join(",")}
                />
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}
