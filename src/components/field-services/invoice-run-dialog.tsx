"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SELECT_CLASS, callApi } from "@/components/field-services/field-ui";
import { useSubAccount } from "@/context/sub-account-context";
import { addDaysToKey } from "@/lib/field-services/time";
import { jobTerms } from "@/lib/field-services/terms";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import type { InvoiceRunPreview, InvoiceRunResult } from "@/lib/server/field-invoice-run-service";

const WEEK_COUNTS: [number, string][] = [
  [1, "That week only"],
  [2, "2 weeks"],
  [3, "3 weeks"],
  [4, "4 weeks"],
  [0, "Every unbilled week up to then"],
];

function shortDate(key: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

/** The Sunday a Monday-to-Sunday week ends on. */
export function weekEndingLabel(weekStart: string): string {
  return `Week ending ${shortDate(addDaysToKey(weekStart, 6))}`;
}

function hoursText(h: number): string {
  return `${Math.round(h * 100) / 100} h`;
}

const BILLING_LABEL: Record<string, string> = {
  time_and_materials: "Time and materials",
  day_rate: "Day rate",
  lump_sum: "Fixed price",
};

/** Draft one invoice per project for the weeks you choose, from approved timesheet weeks. */
export function InvoiceRunDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { subAccountId, saPath } = useSubAccount();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const base = `/api/sub-accounts/${subAccountId}/field-services`;

  const [data, setData] = useState<InvoiceRunPreview | null>(null);
  const [weekEnding, setWeekEnding] = useState("");
  const [weeks, setWeeks] = useState(1);
  const [includeParts, setIncludeParts] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<InvoiceRunResult[] | null>(null);
  const [numbers, setNumbers] = useState<Record<string, string>>({});

  const load = useCallback(
    async (end: string, count: number, parts: boolean) => {
      setLoading(true);
      setError("");
      try {
        const qs = new URLSearchParams();
        if (end) qs.set("weekEnding", end);
        if (count > 0) qs.set("weeks", String(count));
        if (!parts) qs.set("includeParts", "0");
        const res = await fetch(`${base}/invoice-run?${qs.toString()}`, { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as InvoiceRunPreview & { error?: string };
        if (!res.ok) {
          setError(body.error ?? "Couldn't load the invoice run.");
          setData(null);
          return;
        }
        setData(body);
        setWeekEnding(body.weekEnding);
        setSelected(new Set(body.rows.filter((r) => r.ready).map((r) => r.jobId)));
      } catch {
        setError("Couldn't reach the server. Check your connection.");
      } finally {
        setLoading(false);
      }
    },
    [base],
  );

  useEffect(() => {
    if (!open) return;
    setResults(null);
    setWeeks(1);
    setIncludeParts(true);
    void load("", 1, true);
  }, [open, load]);

  function toggle(jobId: string, on: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  }

  async function draft() {
    if (selected.size === 0) return;
    setBusy(true);
    setNumbers(Object.fromEntries((data?.rows ?? []).map((r) => [r.jobId, r.number])));
    const res = await callApi<{ results: InvoiceRunResult[] }>(`${base}/invoice-run`, "POST", {
      weekEnding,
      weeks,
      jobIds: [...selected],
      includeParts,
    });
    setBusy(false);
    if (!res) return;
    setResults(res.results);
    const made = res.results.filter((r) => r.ok).length;
    if (made > 0) toast.success(`${made} invoice${made === 1 ? "" : "s"} drafted. Review each before sending.`);
    void load(weekEnding, weeks, includeParts);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Invoice run</DialogTitle>
          <DialogDescription>
            Pick the week to bill up to and how many weeks to include. Only approved timesheet weeks are billed, one
            invoice for each {terms.job}. Nothing is sent until you send it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Week ending</Label>
            <select
              className={SELECT_CLASS}
              value={weekEnding}
              disabled={loading || !data}
              onChange={(e) => {
                setWeekEnding(e.target.value);
                void load(e.target.value, weeks, includeParts);
              }}
            >
              {(data?.weeks ?? []).map((w) => (
                <option key={w} value={w}>
                  {weekEndingLabel(w)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Include</Label>
            <select
              className={SELECT_CLASS}
              value={weeks}
              disabled={loading || !data}
              onChange={(e) => {
                const n = Number(e.target.value);
                setWeeks(n);
                void load(weekEnding, n, includeParts);
              }}
            >
              {WEEK_COUNTS.map(([n, label]) => (
                <option key={n} value={n}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm">
            <Checkbox
              checked={includeParts}
              onCheckedChange={(v) => {
                setIncludeParts(v === true);
                void load(weekEnding, weeks, v === true);
              }}
            />
            Include logged parts
          </label>
        </div>

        {error ? (
          <p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{error}</p>
        ) : loading && !data ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : data && data.rows.length === 0 ? (
          <p className="rounded-lg border p-4 text-sm text-muted-foreground">
            Nothing to bill for those weeks. Time shows here once it is logged, and is billed once its week is
            approved on the Timesheets tab.
          </p>
        ) : data ? (
          <ul className={"divide-y rounded-lg border" + (loading ? " opacity-60" : "")}>
            {data.rows.map((r) => (
              <li key={r.jobId} className="flex items-start gap-3 p-3">
                <Checkbox
                  className="mt-1"
                  checked={selected.has(r.jobId)}
                  onCheckedChange={(v) => toggle(r.jobId, v === true)}
                  aria-label={`Include ${r.number}`}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium">
                    <span className="text-muted-foreground">{r.number}</span> {r.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.contactName || "No customer"} · {BILLING_LABEL[r.billingType] ?? r.billingType}
                  </p>
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    {r.approvedHours > 0 && (
                      <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-green-700 dark:text-green-400">
                        {hoursText(r.approvedHours)} approved
                      </span>
                    )}
                    {r.awaitingHours > 0 && (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-400">
                        {hoursText(r.awaitingHours)} waiting for approval
                      </span>
                    )}
                    {r.notSubmittedHours > 0 && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                        {hoursText(r.notSubmittedHours)} not submitted
                      </span>
                    )}
                    {r.parts > 0 && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                        {r.parts} part{r.parts === 1 ? "" : "s"}
                      </span>
                    )}
                    {r.ownLines && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                        {terms.Job} lines not billed yet
                      </span>
                    )}
                    {!r.ready && (
                      <span className="text-muted-foreground">Nothing approved yet. Approve its weeks first.</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {data && (data.repeatingSkipped > 0 || data.truncated) && (
          <p className="text-xs text-muted-foreground">
            {data.repeatingSkipped > 0
              ? `${data.repeatingSkipped} repeating ${data.repeatingSkipped === 1 ? terms.job : terms.jobs} left out: those are billed visit by visit from the ${terms.job}. `
              : ""}
            {data.truncated ? "Only the first 200 open projects are shown." : ""}
          </p>
        )}

        {results && (
          <ul className="space-y-1 rounded-lg border p-3 text-sm">
            {results.map((r) => (
              <li key={r.jobId} className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{numbers[r.jobId] ?? "Project"}</span>
                {r.ok ? (
                  <>
                    <span>
                      Invoice {r.quoteNumber}: {hoursText(r.hoursBilled ?? 0)}
                      {r.partsBilled ? `, ${r.partsBilled} part${r.partsBilled === 1 ? "" : "s"}` : ""}
                      {r.hoursWaiting ? `, ${hoursText(r.hoursWaiting)} left off (not approved)` : ""}
                    </span>
                    <Link className="text-xs underline-offset-2 hover:underline" href={saPath(`/quotes/${r.id}`)}>
                      Open invoice
                    </Link>
                  </>
                ) : (
                  <span className="text-destructive">{r.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button disabled={busy || selected.size === 0} onClick={() => void draft()}>
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Draft {selected.size} invoice{selected.size === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
