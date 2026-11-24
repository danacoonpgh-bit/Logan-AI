"use client";

import { jobAllowanceMinutes } from "@/lib/field-services/duration";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Repeat } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { StaffPicker } from "@/components/field-services/staff-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi, SELECT_CLASS } from "@/components/field-services/field-ui";
import { useFieldData } from "@/components/field-services/field-data";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { jobTerms, workerTerms } from "@/lib/field-services/terms";
import { describeRecurrence } from "@/lib/field-services/recurrence";
import { utcToZonedInput } from "@/lib/field-services/time";
import type { Job } from "@/types/field-services";

export function JobRepeatSection({ job }: { job: Job }) {
  const { subAccountId } = useSubAccount();
  const { workers, services } = useFieldData();
  const { config: fieldConfig } = useFieldConfig();
  const terms = jobTerms(fieldConfig);
  const wt = workerTerms(fieldConfig);
  const base = `/api/sub-accounts/${subAccountId}/field-services/jobs/${job.id}/recurrence`;
  const active = job.jobType === "recurring" && job.recurrence?.active === true;
  const cfg = job.recurrence;
  const locked = job.status === "closed" || job.status === "cancelled";

  const tomorrow = utcToZonedInput(new Date(Date.now() + 86_400_000), job.timezone).slice(0, 10);
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState<"week" | "month">(cfg?.unit ?? "week");
  const [every, setEvery] = useState(String(cfg?.every ?? 1));
  const [startDate, setStartDate] = useState(cfg?.startDate ?? tomorrow);
  const [time, setTime] = useState(cfg?.time ?? "09:00");
  const allowance = jobAllowanceMinutes(job.lineItems, services);
  const [minutes, setMinutes] = useState(String(cfg?.durationMinutes ?? (allowance || 60)));
  const [picked, setPicked] = useState<string[]>(cfg?.workerIds ?? []);
  const [endsOn, setEndsOn] = useState(cfg?.endsOn ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const active_workers = workers.filter((w) => w.status === "active");

  function openForm() {
    setUnit(cfg?.unit ?? "week");
    setEvery(String(cfg?.every ?? 1));
    setStartDate(cfg?.startDate ?? tomorrow);
    setTime(cfg?.time ?? "09:00");
    setMinutes(String(cfg?.durationMinutes ?? (allowance || 60)));
    setPicked(cfg?.workerIds ?? []);
    setEndsOn(cfg?.endsOn ?? "");
    setConfirmStop(false);
    setOpen(true);
  }

  async function save() {
    if (!Number.isInteger(Number(every)) || Number(every) < 1) {
      toast.error("Repeat every a whole number of weeks or months.");
      return;
    }
    setBusy(true);
    const res = await callApi<{ created: number; removed?: number }>(base, "POST", {
      action: active ? "update" : "start",
      schedule: {
        unit,
        every: Number(every),
        startDate,
        time,
        durationMinutes: Number(minutes),
        workerIds: picked,
        endsOn: endsOn || null,
      },
    });
    setBusy(false);
    if (res) {
      toast.success(
        active
          ? `Schedule updated. ${res.created} visit${res.created === 1 ? "" : "s"} created.`
          : `Repeat started. ${res.created} visit${res.created === 1 ? "" : "s"} created, up to 12 months ahead.`,
      );
      setOpen(false);
    }
  }

  async function stop() {
    if (!confirmStop) {
      setConfirmStop(true);
      return;
    }
    setBusy(true);
    const res = await callApi<{ removed: number }>(base, "POST", { action: "stop" });
    setBusy(false);
    setConfirmStop(false);
    if (res) toast.success(`Stopped repeating. ${res.removed} future visit${res.removed === 1 ? "" : "s"} removed.`);
  }

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Repeat className="h-4 w-4" /> Repeat visits
      </h3>

      {active && cfg ? (
        <div className="space-y-1 rounded-lg border p-3 text-sm">
          <p className="font-medium">{describeRecurrence(cfg)}</p>
          <p className="text-xs text-muted-foreground">
            Visits are created up to 12 months ahead and topped up automatically
            {cfg.endsOn ? `, until ${cfg.endsOn}` : ""}.
            {cfg.skipped.length > 0 ? ` ${cfg.skipped.length} date${cfg.skipped.length === 1 ? "" : "s"} skipped.` : ""}
          </p>
        </div>
      ) : cfg && !cfg.active ? (
        <p className="text-xs text-muted-foreground">This {terms.job} used to repeat and has stopped.</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          For weekly or monthly work such as cleaning or lawn care. We create the visits for you.
        </p>
      )}

      {!locked && !open && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={openForm}
          >
            {active ? "Change the schedule" : `Make this ${terms.job} repeat`}
          </Button>
          {active && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void stop()}>
              {confirmStop ? "Tap again to stop and remove future visits" : "Stop repeating"}
            </Button>
          )}
        </div>
      )}

      {open && (
        <div className="space-y-3 rounded-lg border p-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Repeat every</Label>
              <div className="flex gap-2">
                <Input className="h-9 w-16" inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value)} />
                <select
                  className={SELECT_CLASS}
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as "week" | "month")}
                >
                  <option value="week">week(s)</option>
                  <option value="month">month(s)</option>
                </select>
              </div>
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">First visit date</Label>
              <Input className="h-9" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Start time ({job.timezone})</Label>
              <Input className="h-9" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">How long (minutes)</Label>
              <Input className="h-9" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Stop on (optional)</Label>
              <Input className="h-9" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </div>
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Who goes</Label>
            <StaffPicker
              people={active_workers}
              value={picked}
              onChange={setPicked}
              noun={wt.workers}
              empty={`No ${wt.workers} yet. Visits will be unassigned.`}
            />
          </div>
          {active && (
            <p className="text-xs text-muted-foreground">
              Changing the schedule replaces future visits you haven&apos;t edited by hand. Visits you
              moved or reassigned yourself are kept.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              {active ? "Save schedule" : "Start repeating"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
