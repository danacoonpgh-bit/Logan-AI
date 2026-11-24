"use client";

import { workerHoursOn } from "@/lib/field-services/working-hours";
import { FindTimeDialog } from "@/components/field-services/find-time-dialog";
import { DayStartDialog } from "@/components/field-services/day-start-dialog";
import { BalanceStaffDialog } from "@/components/field-services/balance-staff-dialog";
import { DayPlanDialog } from "@/components/field-services/day-plan-dialog";
import { RouteSuggestDialog } from "@/components/field-services/route-suggest-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
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
import { Label } from "@/components/ui/label";
import { useFieldData } from "@/components/field-services/field-data";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { jobTerms, workerTerms, withArticle, withArticleCap } from "@/lib/field-services/terms";
import { mondayOf } from "@/lib/field-services/intervals";
import { cn } from "@/lib/utils";
import { VisitStatusPill, SELECT_CLASS, callApi } from "@/components/field-services/field-ui";
import { DispatchCalendar, readableText, toDate, type CalendarColumn } from "@/components/field-services/dispatch-calendar";
import {
  addDaysToKey,
  formatInZone,
  utcToZonedInput,
  zonedDateKey,
  zonedTimeToUtc,
} from "@/lib/field-services/time";
import type { Visit } from "@/types/field-services";

function EditVisitDialog({
  visit,
  timezone,
  onClose,
}: {
  visit: Visit | null;
  timezone: string;
  onClose: () => void;
}) {
  const { subAccountId } = useSubAccount();
  const { workers } = useFieldData();
  const { config: fieldCfg } = useFieldConfig();
  const [startLocal, setStartLocal] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);

  useEffect(() => {
    if (!visit) return;
    const s = toDate(visit.scheduledStart);
    const e = toDate(visit.scheduledEnd);
    setStartLocal(s ? utcToZonedInput(s, timezone) : "");
    setMinutes(s && e ? Math.max(15, Math.round((e.getTime() - s.getTime()) / 60_000)) : 60);
    setPicked(visit.workerIds);
  }, [visit, timezone]);

  async function save() {
    if (!visit) return;
    const start = zonedTimeToUtc(startLocal, timezone);
    if (Number.isNaN(start.getTime())) {
      toast.error("Pick a start date and time.");
      return;
    }
    setBusy(true);
    const res = await callApi<{ warnings?: string[] }>(
      `/api/sub-accounts/${subAccountId}/field-services/visits/${visit.id}`,
      "PATCH",
      {
        scheduledStart: start.toISOString(),
        scheduledEnd: new Date(start.getTime() + minutes * 60_000).toISOString(),
        workerIds: picked,
      },
    );
    setBusy(false);
    if (!res) return;
    toast.success("Visit updated.");
    for (const w of res.warnings ?? []) toast.warning(w);
    onClose();
  }

  return (
    <Dialog open={visit !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Change visit</DialogTitle>
          <DialogDescription>
            {visit?.jobNumber} · {visit?.jobTitle}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Start ({timezone})
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
                Length (minutes)
              </Label>
              <Input
                inputMode="numeric"
                value={String(minutes)}
                onChange={(e) => setMinutes(Math.max(15, Number(e.target.value.replace(/\D/g, "")) || 60))}
              />
            </div>
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">{workerTerms(fieldCfg).Workers}</Label>
            <StaffPicker
              people={workers.filter((w) => w.status === "active" || picked.includes(w.id))}
              value={picked}
              onChange={setPicked}
              noun={workerTerms(fieldCfg).workers}
            />
          </div>
        </div>
        {visit && (
          <FindTimeDialog
            open={finding}
            onClose={() => setFinding(false)}
            jobId={visit.jobId}
            timezone={timezone}
            minutes={minutes}
            workerIds={picked}
            ignoreVisitId={visit.id}
            onPick={(p) => {
              setStartLocal(utcToZonedInput(new Date(p.startIso), timezone));
              if (picked.length === 0) setPicked(p.workerIds);
            }}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SPANS = [
  { days: 7, label: "Week" },
  { days: 14, label: "2 weeks" },
  { days: 28, label: "4 weeks" },
] as const;

const UNASSIGNED = "_unassigned";

type ViewId = "chart" | "day" | "week";

const VIEWS: { id: ViewId; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week by day" },
  { id: "chart", label: "Hours chart" },
];

interface Cell {
  visits: Visit[];
  ms: number;
  timed: boolean;
  anytime: number;
}

function visitMs(v: Visit): number {
  const s = toDate(v.scheduledStart);
  const e = toDate(v.scheduledEnd);
  return s && e && !v.anytime ? Math.max(0, e.getTime() - s.getTime()) : 0;
}

function hoursCompact(ms: number): string {
  const h = Math.round(ms / 360_000) / 10;
  return `${h}h`;
}

function hoursLabel(ms: number): string {
  const m = Math.round(ms / 60_000);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : h === 0 ? `${r}m` : `${h}h ${r}m`;
}

export function ScheduleTab({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const { subAccount, subAccountId } = useSubAccount();
  const { visits, workers, jobs, services, loaded } = useFieldData();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const wt = workerTerms(config);
  const tz = subAccount?.timezone || "UTC";
  const accentOf = useMemo(() => {
    const colour = new Map(services.filter((sv) => sv.color).map((sv) => [sv.id, sv.color as string]));
    const byJob = new Map<string, string>();
    for (const j of jobs) {
      const hit = j.lineItems.find((l) => l.productId && colour.has(l.productId));
      if (hit?.productId) byJob.set(j.id, colour.get(hit.productId) as string);
    }
    return (v: Visit) => byJob.get(v.jobId) ?? null;
  }, [services, jobs]);
  const todayKey = zonedDateKey(new Date(), tz);
  const [anchor, setAnchor] = useState(todayKey);
  const leadDays = config?.routeLeadDays ?? 1;
  const maxDays = config?.routeMaxDays ?? 7;
  const tooFar = anchor > addDaysToKey(todayKey, maxDays);
  const routeLocked = anchor < addDaysToKey(todayKey, leadDays) || tooFar;
  const firstOpenDay = addDaysToKey(todayKey, leadDays);
  const firstOpenLabel = new Date(`${firstOpenDay}T12:00:00Z`).toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const lockNote = tooFar
    ? `Not available for this day. Route changes only open up to ${maxDays} days ahead. Change how far ahead in Settings, Route suggestions.`
    : routeLocked
    ? `Not available for this day. Days inside the ${leadDays}-day lead time are changed by hand, so this starts from ${firstOpenLabel}. Change the lead time in Settings, Route suggestions.`
    : "";
  const [span, setSpan] = useState<(typeof SPANS)[number]["days"]>(7);
  const [view, setView] = useState<ViewId>("day");
  const [routing, setRouting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [balancing, setBalancing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [person, setPerson] = useState("all");
  const [editing, setEditing] = useState<Visit | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    visit: Visit;
    start: Date;
    end: Date;
    workerIds: string[];
    /** Only sent when the person changed, so crew edited meanwhile are never overwritten. */
    crewChanged: boolean;
    zone: string;
    from: string;
    to: string;
    crewChange: string;
  } | null>(null);
  const [moving, setMoving] = useState(false);
  const [openCell, setOpenCell] = useState<{ title: string; day: string; ids: string[] } | null>(null);
  const openVisits = useMemo(
    () => (openCell ? visits.filter((v) => openCell.ids.includes(v.id) && v.status !== "cancelled") : []),
    [openCell, visits],
  );

  const start = mondayOf(anchor);
  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDaysToKey(start, i)), [start, span]);
  const jobTz = useCallback((jobId: string) => jobs.find((j) => j.id === jobId)?.timezone ?? tz, [jobs, tz]);

  const calendarColumns = useMemo<CalendarColumn[]>(() => {
    if (view === "chart") return [];
    const live = visits.filter((v) => v.status !== "cancelled" && v.status !== "no_show");
    const known = new Set(workers.map((w) => w.id));
    const isLoose = (v: Visit) => v.workerIds.every((id) => !known.has(id));
    const weekday = (d: string) => formatInZone(zonedTimeToUtc(`${d}T12:00`, tz), tz, { weekday: "short" });
    const dateText = (d: string) => formatInZone(zonedTimeToUtc(`${d}T12:00`, tz), tz, { day: "numeric", month: "short" });
    const isWeekend = (d: string) => {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      return dow === 0 || dow === 6;
    };
    if (view === "day") {
      const onDay = live.filter((v) => {
        const s = toDate(v.scheduledStart);
        return !!s && zonedDateKey(s, jobTz(v.jobId)) === anchor;
      });
      const cols: CalendarColumn[] = workers
        .filter((w) => w.status === "active" || onDay.some((v) => v.workerIds.includes(w.id)))
        .map((w) => ({
          key: w.id,
          title: w.status === "active" ? w.name : `${w.name} (removed)`,
          day: anchor,
          today: anchor === todayKey,
          visits: onDay.filter((v) => v.workerIds.includes(w.id)),
          hours: workerHoursOn(w, anchor),
          color: w.color,
        }));
      const loose = onDay.filter(isLoose);
      if (loose.length > 0 || cols.length === 0) {
        cols.push({ key: UNASSIGNED, title: "Unassigned", day: anchor, today: anchor === todayKey, visits: loose, color: "#94a3b8" });
      }
      return cols;
    }
    const pick = (v: Visit) => (person === "all" ? true : person === UNASSIGNED ? isLoose(v) : v.workerIds.includes(person));
    const shown = live.filter(pick);
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDaysToKey(mondayOf(anchor), i);
      return {
        key: d,
        title: weekday(d),
        subtitle: dateText(d),
        day: d,
        today: d === todayKey,
        weekend: isWeekend(d),
        visits: shown,
        hours: person !== "all" && person !== UNASSIGNED ? workerHoursOn(workers.find((x) => x.id === person), d) : undefined,
        color: "",
      };
    });
  }, [view, visits, workers, anchor, person, tz, todayKey, jobTz]);

  const colorOfVisit = useCallback(
    (v: Visit, col: CalendarColumn) => {
      if (col.color) return col.color;
      const w = (person !== "all" ? workers.find((x) => x.id === person) : null) ?? workers.find((x) => v.workerIds.includes(x.id));
      return w?.color ?? "#94a3b8";
    },
    [person, workers],
  );
  const canMoveVisit = useCallback((v: Visit) => v.status === "pending" && !v.anytime, []);

  // A drop only prepares the change; the office confirms it because the crew and the customer are told.
  const prepareMove = useCallback(
    (v: Visit, from: CalendarColumn, to: CalendarColumn, startMin: number) => {
      const zone = jobTz(v.jobId);
      const s0 = toDate(v.scheduledStart);
      const e0 = toDate(v.scheduledEnd);
      if (!s0) return;
      const len = e0 ? e0.getTime() - s0.getTime() : 3_600_000;
      const hh = String(Math.floor(startMin / 60)).padStart(2, "0");
      const mm = String(startMin % 60).padStart(2, "0");
      const start = zonedTimeToUtc(`${to.day}T${hh}:${mm}`, zone);
      if (Number.isNaN(start.getTime())) return;
      let workerIds = v.workerIds;
      let crewChange = "";
      let crewChanged = false;
      if (view === "day" && to.key !== from.key) {
        const active = new Set(workers.filter((w) => w.status === "active").map((w) => w.id));
        const without = v.workerIds.filter((id) => id !== from.key && active.has(id));
        workerIds = to.key === UNASSIGNED || without.includes(to.key) ? without : [...without, to.key];
        crewChanged = true;
        const nameOf = (c: CalendarColumn) => (c.key === UNASSIGNED ? "Unassigned" : c.title);
        crewChange =
          to.key === UNASSIGNED && workerIds.length > 0
            ? `${nameOf(from)} taken off; the others stay`
            : `${nameOf(from)} to ${nameOf(to)}`;
      }
      const label = (d: Date) => formatInZone(d, zone, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
      setPendingMove({
        visit: v,
        start,
        end: new Date(start.getTime() + len),
        workerIds,
        crewChanged,
        zone,
        from: label(s0),
        to: label(start),
        crewChange,
      });
    },
    [jobTz, view, workers],
  );

  async function confirmMove() {
    if (!pendingMove) return;
    setMoving(true);
    const res = await callApi<{ warnings?: string[] }>(
      `/api/sub-accounts/${subAccountId}/field-services/visits/${pendingMove.visit.id}`,
      "PATCH",
      {
        scheduledStart: pendingMove.start.toISOString(),
        scheduledEnd: pendingMove.end.toISOString(),
        ...(pendingMove.crewChanged ? { workerIds: pendingMove.workerIds } : {}),
      },
    );
    setMoving(false);
    if (!res) return;
    toast.success("Visit moved.");
    for (const w of res.warnings ?? []) toast.warning(w);
    setPendingMove(null);
  }

  const namesOf = useCallback(
    (v: Visit) =>
      workers
        .filter((w) => v.workerIds.includes(w.id))
        .map((w) => w.name)
        .join(", "),
    [workers],
  );

  const rows = useMemo(() => {
    const zoneOf = (jobId: string) => jobs.find((j) => j.id === jobId)?.timezone ?? tz;
    const knownIds = new Set(workers.map((w) => w.id));
    const first = days[0];
    const last = days[days.length - 1];
    const byJob = new Map<string, Visit[]>();
    for (const v of visits) {
      const s = toDate(v.scheduledStart);
      if (!s || v.status === "cancelled" || v.status === "no_show") continue;
      const key = zonedDateKey(s, zoneOf(v.jobId));
      if (key < first || key > last) continue;
      byJob.set(v.jobId, [...(byJob.get(v.jobId) ?? []), v]);
    }
    const out = [...byJob.entries()].map(([jobId, list]) => {
      const sorted = [...list].sort((a, b) => (toDate(a.scheduledStart)?.getTime() ?? 0) - (toDate(b.scheduledStart)?.getTime() ?? 0));
      const cellFor = (pick: (v: Visit) => boolean) => {
        const map = new Map<string, Cell>();
        for (const v of sorted) {
          if (!pick(v)) continue;
          const day = zonedDateKey(toDate(v.scheduledStart)!, zoneOf(jobId));
          const cell = map.get(day) ?? { visits: [], ms: 0, timed: false, anytime: 0 };
          cell.visits.push(v);
          cell.ms += visitMs(v);
          cell.timed = cell.timed || !v.anytime;
          if (v.anytime) cell.anytime += 1;
          map.set(day, cell);
        }
        return map;
      };
      const crew: { id: string; name: string; color: string; cells: Map<string, Cell> }[] = [];
      for (const w of workers) {
        if (!sorted.some((v) => v.workerIds.includes(w.id))) continue;
        crew.push({ id: w.id, name: w.status === "active" ? w.name : `${w.name} (removed)`, color: w.color, cells: cellFor((v) => v.workerIds.includes(w.id)) });
      }
      const loose = (v: Visit) => v.workerIds.every((id) => !knownIds.has(id));
      if (sorted.some(loose)) crew.push({ id: UNASSIGNED, name: "Unassigned", color: "#94a3b8", cells: cellFor(loose) });
      const head = sorted[0];
      return {
        jobId,
        number: head.jobNumber,
        title: head.jobTitle,
        contact: head.contactName,
        total: cellFor(() => true),
        crew,
        firstAt: toDate(head.scheduledStart)?.getTime() ?? 0,
      };
    });
    return out.sort((a, b) => a.firstAt - b.firstAt || a.number.localeCompare(b.number));
  }, [visits, workers, jobs, days, tz]);

  const dayTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of rows) for (const [day, c] of r.total) totals.set(day, (totals.get(day) ?? 0) + c.ms);
    return totals;
  }, [rows]);

  const shift = (dir: number) =>
    setAnchor((a) => (view === "day" ? addDaysToKey(a, dir) : addDaysToKey(mondayOf(a), dir * (view === "week" ? 7 : span))));
  const rangeLabel =
    view === "day"
      ? formatInZone(zonedTimeToUtc(`${anchor}T12:00`, tz), tz, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : view === "week"
        ? `${formatInZone(zonedTimeToUtc(`${mondayOf(anchor)}T12:00`, tz), tz, { day: "numeric", month: "short" })} – ${formatInZone(
            zonedTimeToUtc(`${addDaysToKey(mondayOf(anchor), 6)}T12:00`, tz),
            tz,
            { day: "numeric", month: "short", year: "numeric" },
          )}`
        : `${formatInZone(zonedTimeToUtc(`${days[0]}T12:00`, tz), tz, { day: "numeric", month: "short" })} – ${formatInZone(
            zonedTimeToUtc(`${days[days.length - 1]}T12:00`, tz),
            tz,
            { day: "numeric", month: "short", year: "numeric" },
          )}`;
  const inView = view === "day" ? anchor === todayKey : view === "week" ? mondayOf(anchor) === mondayOf(todayKey) : days.includes(todayKey);
  const dayWidth = span === 7 ? "minmax(4.5rem,1fr)" : span === 14 ? "minmax(3.25rem,1fr)" : "minmax(2.75rem,1fr)";
  const gridCols = `clamp(8rem, 38vw, 15rem) repeat(${span}, ${dayWidth})`;

  return (
    <section className="rounded-2xl border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Schedule</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {view === "chart"
              ? `Each ${terms.job} with the ${wt.workers} on it and their scheduled hours by day. ${withArticleCap(wt.worker)}'s bar is the length of their visits; the ${terms.job} row and the total count each visit once. Click a bar to see its visits.`
              : view === "day"
                ? `One column for each ${wt.worker}, with their visits at the time they happen. Overlapping visits sit side by side. Click a visit to open it, or drag a waiting visit to move it.`
                : `Each day of the week with its visits at the time they happen. Pick ${withArticle(wt.worker)} to see only their week. Click a visit to open it, or drag a waiting visit to move it.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                aria-pressed={view === v.id}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm",
                  view === v.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
          {view === "week" && (
            <select className={cn(SELECT_CLASS, "w-44")} value={person} onChange={(e) => setPerson(e.target.value)} aria-label={wt.Worker}>
              <option value="all">Everyone</option>
              {workers
                .filter((w) => w.status === "active")
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              <option value={UNASSIGNED}>Unassigned</option>
            </select>
          )}
          {view === "chart" && <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="Range">
            {SPANS.map((s) => (
              <button
                key={s.days}
                onClick={() => setSpan(s.days)}
                aria-pressed={span === s.days}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm",
                  span === s.days ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>}
          <Button variant="outline" size="icon" aria-label="Earlier" onClick={() => shift(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Input
            type="date"
            className="w-40"
            value={anchor}
            onChange={(e) => e.target.value && setAnchor(e.target.value)}
            aria-label="Go to date"
          />
          <Button variant="outline" size="icon" aria-label="Later" onClick={() => shift(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          {view === "day" && config?.routeSuggestionsEnabled === true && (
            <>
              <Button
                variant="outline"
                size="sm"
                title="Where each person's day begins on this date, when it is not their usual start address."
                onClick={() => setStarting(true)}
              >
                Day starts
              </Button>
              <span
                className="inline-flex"
                title={lockNote || "Shares this day's unassigned visits between the staff who are free, grouped by area. Visits you placed by hand stay where they are."}
              >
                <Button variant="outline" size="sm" disabled={routeLocked} onClick={() => setPlanning(true)}>
                  Plan the day
                </Button>
              </span>
              <span
                className="inline-flex"
                title={lockNote || "Keeps every visit's time and hands some to a different person so each day is made of nearby visits. Only visits the system placed itself can change person."}
              >
                <Button variant="outline" size="sm" disabled={routeLocked} onClick={() => setBalancing(true)}>
                  Balance staff
                </Button>
              </span>
              <span
                className="inline-flex"
                title={lockNote || "Reorders one person's visits for this day to cut the driving, and re-times them. You choose the person and approve the change."}
              >
                <Button variant="outline" size="sm" disabled={routeLocked} onClick={() => setRouting(true)}>
                  Suggest route
                </Button>
              </span>
            </>
          )}
          <Button variant="outline" size="sm" disabled={inView} onClick={() => setAnchor(todayKey)}>
            Today
          </Button>
        </div>
      </div>
      <p className="mt-3 text-sm font-medium">{rangeLabel}</p>

      {!loaded ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : view !== "chart" ? (
        <DispatchCalendar
          columns={calendarColumns}
          timezone={tz}
          zoneOf={jobTz}
          colorOf={colorOfVisit}
          namesOf={namesOf}
          accentOf={accentOf}
          canMove={canMoveVisit}
          onMove={prepareMove}
          onPick={(v, col) =>
            setOpenCell({ title: `${v.jobNumber} · ${v.jobTitle}`, day: col.day, ids: [v.id] })
          }
        />
      ) : rows.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Nothing scheduled in this range.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border">
          <div className="min-w-max" style={{ minWidth: span === 7 ? "46rem" : undefined }}>
            <div className="grid border-b bg-muted/40 text-xs" style={{ gridTemplateColumns: gridCols }}>
              <div className="sticky left-0 z-10 bg-muted px-3 py-2 font-medium text-muted-foreground">
                {terms.Job} / {wt.worker}
              </div>
              {days.map((d) => {
                const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
                return (
                  <div
                    key={d}
                    aria-current={d === todayKey ? "date" : undefined}
                    className={cn(
                      "px-1 py-2 text-center",
                      d === todayKey && "bg-primary/10 font-semibold text-primary",
                      d !== todayKey && (dow === 0 || dow === 6) && "bg-muted/60",
                    )}
                  >
                    <div className="uppercase tracking-wide">
                      {formatInZone(zonedTimeToUtc(`${d}T12:00`, tz), tz, { weekday: "short" })}
                    </div>
                    <div className="tabular-nums text-muted-foreground">
                      {formatInZone(zonedTimeToUtc(`${d}T12:00`, tz), tz, { day: "numeric", month: span === 7 ? "short" : undefined })}
                    </div>
                  </div>
                );
              })}
            </div>

            {rows.map((r) => (
              <div key={r.jobId} className="border-b last:border-b-0">
                <div className="grid" style={{ gridTemplateColumns: gridCols }}>
                  <button
                    onClick={() => onOpenJob(r.jobId)}
                    className="sticky left-0 z-10 min-w-0 bg-muted px-3 py-2 text-left hover:bg-accent"
                    title={`Open ${r.number} ${r.title}`}
                  >
                    <p className="truncate text-sm font-semibold">
                      {r.number} · {r.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{r.contact}</p>
                  </button>
                  {days.map((d) => {
                    const c = r.total.get(d);
                    return (
                      <div key={d} className={cn("flex items-center justify-center bg-muted/20 px-1 text-xs text-muted-foreground", d === todayKey && "bg-primary/10")}>
                        {c ? <span className="whitespace-nowrap tabular-nums">{c.timed ? (span > 7 ? hoursCompact(c.ms) : hoursLabel(c.ms)) : `${c.visits.length}×`}</span> : null}
                      </div>
                    );
                  })}
                </div>

                {r.crew.map((w) => (
                  <div key={w.id} className="grid" style={{ gridTemplateColumns: gridCols }}>
                    <div className="sticky left-0 z-10 flex min-w-0 items-center gap-2 bg-card py-1.5 pl-6 pr-3 text-sm">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: w.color }} />
                      <span className="truncate">{w.name}</span>
                    </div>
                    {days.map((d) => {
                      const c = w.cells.get(d);
                      const done = !!c && c.visits.every((v) => v.status === "completed");
                      return (
                        <div key={d} className={cn("flex items-center px-0.5 py-1", d === todayKey && "bg-primary/5")}>
                          {c && (
                            <button
                              onClick={() =>
                                setOpenCell({ title: `${r.number} · ${r.title} — ${w.name}`, day: d, ids: c.visits.map((v) => v.id) })
                              }
                              className={cn(
                                "h-8 w-full whitespace-nowrap rounded-md px-1 font-medium tabular-nums shadow-sm transition-opacity hover:opacity-90",
                                span > 7 ? "text-[10px]" : "text-xs",
                                done && "text-foreground",
                              )}
                              style={{
                                backgroundColor: done ? `${w.color}59` : w.color,
                                color: done ? undefined : readableText(w.color),
                              }}
                              aria-haspopup="dialog"
                              aria-label={`${r.number} ${r.title}, ${w.name}, ${formatInZone(zonedTimeToUtc(`${d}T12:00`, tz), tz, { weekday: "long", day: "numeric", month: "long" })}: ${c.timed ? hoursLabel(c.ms) : "any time"}, ${c.visits.length} visit${c.visits.length === 1 ? "" : "s"}`}
                            >
                              {c.timed ? (span > 7 ? hoursCompact(c.ms) : hoursLabel(c.ms)) : "Any"}
                              {c.timed && c.anytime > 0 ? ` +${c.anytime}` : ""}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}

            <div className="grid border-t bg-muted/40 text-xs font-medium" style={{ gridTemplateColumns: gridCols }}>
              <div className="sticky left-0 z-10 bg-muted px-3 py-2">Scheduled (each visit once)</div>
              {days.map((d) => (
                <div key={d} className="px-1 py-2 text-center tabular-nums">
                  {dayTotals.get(d) ? (span > 7 ? hoursCompact(dayTotals.get(d)!) : hoursLabel(dayTotals.get(d)!)) : "–"}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <Dialog open={openCell !== null} onOpenChange={(o) => !o && setOpenCell(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="break-words">{openCell?.title}</DialogTitle>
            <DialogDescription>
              {openCell
                ? formatInZone(zonedTimeToUtc(`${openCell.day}T12:00`, tz), tz, {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  })
                : ""}
            </DialogDescription>
          </DialogHeader>
          <ul className="divide-y rounded-lg border">
            {openVisits.map((v) => {
              const s = toDate(v.scheduledStart);
              const e = toDate(v.scheduledEnd);
              const zone = jobTz(v.jobId);
              return (
                <li key={v.id} className="space-y-1.5 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {v.anytime
                        ? "Any time"
                        : s && e
                          ? `${formatInZone(s, zone, { hour: "numeric", minute: "2-digit" })} – ${formatInZone(e, zone, { hour: "numeric", minute: "2-digit" })}`
                          : "—"}
                    </span>
                    <VisitStatusPill status={v.status} />
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {v.contactName}
                    {v.address ? ` · ${v.address}` : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => { setOpenCell(null); onOpenJob(v.jobId); }}>
                      Open {terms.job}
                    </Button>
                    {!["completed", "no_show", "cancelled"].includes(v.status) && (
                      <Button variant="outline" size="sm" onClick={() => { setOpenCell(null); setEditing(v); }}>
                        Change visit
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingMove !== null} onOpenChange={(o) => !o && !moving && setPendingMove(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move this visit?</DialogTitle>
            <DialogDescription>
              {pendingMove?.visit.jobNumber} · {pendingMove?.visit.jobTitle}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">From</span> {pendingMove?.from}
            </p>
            <p>
              <span className="text-muted-foreground">To</span> <span className="font-medium">{pendingMove?.to}</span>
            </p>
            {pendingMove?.crewChange && (
              <p>
                <span className="text-muted-foreground">{wt.Worker}</span> <span className="font-medium">{pendingMove.crewChange}</span>
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              The crew are told, and the customer gets this service&apos;s booked message if it is switched on.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingMove(null)} disabled={moving}>
              Cancel
            </Button>
            <Button onClick={() => void confirmMove()} disabled={moving}>
              {moving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Move visit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DayStartDialog open={starting} day={anchor} onClose={() => setStarting(false)} />
      <DayPlanDialog open={planning} day={anchor} onClose={() => setPlanning(false)} />
      <BalanceStaffDialog open={balancing} day={anchor} onClose={() => setBalancing(false)} />
      <RouteSuggestDialog open={routing} day={anchor} onClose={() => setRouting(false)} />

      <EditVisitDialog
        visit={editing}
        timezone={editing ? jobTz(editing.jobId) : tz}
        onClose={() => setEditing(null)}
      />
    </section>
  );
}
