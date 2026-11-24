"use client";

import { parseHoursInput } from "@/lib/field-services/hours-input";
import { activeTimeKinds, kindLabelOf } from "@/lib/field-services/time-kinds";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callApi } from "@/components/field-services/field-ui";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { addDaysToKey, formatInZone, utcToZonedInput, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import { unionMs, type Span } from "@/lib/field-services/intervals";
import { buttonColorClasses } from "@/lib/field-services/button-colors";
import { jobTerms, workerTerms, labourTerm, activityTerm } from "@/lib/field-services/terms";
import { categoryLabel, expenseTotalsText } from "@/lib/field-services/expense-categories";
import { formatMoneyCode } from "@/lib/field-services/money";
import { cn } from "@/lib/utils";
import type { CrewEntryView, CrewTimeState } from "@/lib/server/field-crew-time-service";
import type { OfficeRow, SheetStatus } from "@/lib/server/field-timesheet-service";

interface Listing {
  weekStart: string;
  timezone: string;
  rows: OfficeRow[];
}

const STATUS: Record<SheetStatus, { label: string; tone: string }> = {
  submitted: { label: "Submitted", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  approved: { label: "Approved", tone: "bg-green-500/15 text-green-700 dark:text-green-400" },
  sent_back: { label: "Sent back", tone: "bg-red-500/15 text-red-700 dark:text-red-400" },
  open: { label: "Not submitted", tone: "bg-muted text-muted-foreground" },
};


function hm(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function weekLabel(weekStart: string, tz: string): string {
  const a = formatInZone(zonedTimeToUtc(`${weekStart}T12:00`, tz), tz, { day: "numeric", month: "short" });
  const b = formatInZone(zonedTimeToUtc(`${addDaysToKey(weekStart, 6)}T12:00`, tz), tz, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${a} – ${b}`;
}

function DialogShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] content-start overflow-y-auto sm:h-[85vh] sm:max-w-5xl">{children}</DialogContent>
    </Dialog>
  );
}

function InlineShell({ children }: { children: React.ReactNode; onClose: () => void }) {
  return <section className="space-y-4 rounded-2xl border bg-card p-6">{children}</section>;
}

function PlainHeader({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}

function PlainTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold">{children}</h2>;
}

function PlainDesc({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

type Sel = { row: string; day: string } | "all" | null;

function rowKeyOf(e: CrewEntryView): string {
  return `${e.target.type === "visit" ? "job" : e.target.type}:${e.label}:${e.kind}`;
}

const ROW_ORDER: Record<string, number> = { job: 0, internal: 1, none: 2 };

function gridDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(total / 60)}h:${String(total % 60).padStart(2, "0")}m`;
}

export function TimesheetsTab() {
  const { subAccountId, isAdmin } = useSubAccount();
  const { config } = useFieldConfig();
  const base = `/api/sub-accounts/${subAccountId}/field-services/timesheets`;
  const [week, setWeek] = useState<string | null>(null);
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ workerId: string; name: string } | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      const res = await fetch(`${base}/export?from=${from}&to=${to}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? "Couldn't make the export.");
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `timesheets-${from}-to-${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setDownloading(false);
    }
  }

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    try {
      const res = await fetch(week ? `${base}?week=${week}` : base, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as Listing & { error?: string };
      if (mine !== loadSeq.current) return;
      if (!res.ok) {
        setError(body.error ?? "Couldn't load timesheets.");
        return;
      }
      setError(null);
      setData(body);
      setFrom((f) => f || body.weekStart);
      setTo((t) => t || addDaysToKey(body.weekStart, 6));
    } catch {
      setError("Couldn't reach the server.");
    }
  }, [base, week]);

  useEffect(() => {
    if (isAdmin && config?.timesheetsEnabled) void load();
  }, [load, isAdmin, config?.timesheetsEnabled]);

  if (!isAdmin) {
    return (
      <section className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        Only admins approve timesheets.
      </section>
    );
  }
  if (config && !config.timesheetsEnabled) {
    return (
      <section className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        Timesheets are off. Turn them on in Settings.
      </section>
    );
  }

  const tz = data?.timezone ?? "UTC";

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Timesheets</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {workerTerms(config).Workers} submit their week from the app. Only approved weeks go onto invoices.
            </p>
          </div>
          {data && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous week"
                onClick={() => setWeek(addDaysToKey(data.weekStart, -7))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-44 text-center text-sm font-medium">{weekLabel(data.weekStart, tz)}</span>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next week"
                disabled={addDaysToKey(data.weekStart, 7) > zonedDateKey(new Date(), tz)}
                onClick={() => setWeek(addDaysToKey(data.weekStart, 7))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        {error ? (
          <p className="mt-4 text-sm text-destructive">{error}</p>
        ) : !data ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </p>
        ) : data.rows.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No {workerTerms(config).workers} yet.</p>
        ) : (
          <ul className="mt-4 divide-y rounded-lg border">
            {data.rows.map((r) => (
              <li key={r.workerId} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {r.name}
                    {r.removed && <span className="ml-2 text-xs font-normal text-muted-foreground">(removed)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.count === 0 ? "No time logged" : `${hm(r.totalMs)} h · ${r.count} entr${r.count === 1 ? "y" : "ies"}`}
                    {r.running ? " · timer running" : ""}
                  </p>
                </div>
                <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", STATUS[r.status].tone)}>
                  {STATUS[r.status].label}
                </span>
                <Button variant="outline" size="sm" onClick={() => setOpen({ workerId: r.workerId, name: r.name })}>
                  View
                </Button>
              </li>
            ))}
          </ul>
        )}
        {data && <p className="mt-3 text-xs text-muted-foreground">Times are in {tz}. Weeks run Monday to Sunday.</p>}
      </section>

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Export</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A spreadsheet of logged time for payroll, up to three months at a time.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button disabled={!from || !to || downloading} onClick={() => void download()}>
            {downloading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Download CSV
          </Button>
        </div>
      </section>

      {open && data && (
        <WeekDialog
          base={base}
          workerId={open.workerId}
          name={open.name}
          weekStart={data.weekStart}
          tz={tz}
          workers={data.rows.map((r) => ({ workerId: r.workerId, name: r.name }))}
          onSwitch={(workerId, name) => setOpen({ workerId, name })}
          onWeek={(delta) => setWeek(addDaysToKey(data.weekStart, delta * 7))}
          canGoNext={addDaysToKey(data.weekStart, 7) <= zonedDateKey(new Date(), tz)}
          onToday={() => setWeek(null)}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function WeekDialog({
  base,
  workerId,
  name,
  weekStart,
  tz,
  workers,
  onSwitch,
  onWeek,
  canGoNext,
  inline,
  onToday,
  onClose,
  onChanged,
}: {
  base: string;
  workerId: string;
  name: string;
  weekStart: string;
  tz: string;
  workers: { workerId: string; name: string }[];
  onSwitch: (workerId: string, name: string) => void;
  onWeek: (delta: number) => void;
  canGoNext: boolean;
  inline?: boolean;
  onToday?: () => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { subAccountId } = useSubAccount();
  const { config } = useFieldConfig();
  const [state, setState] = useState<CrewTimeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [startLocal, setStartLocal] = useState("");
  const [hoursText, setHoursText] = useState("");
  const [hoursInitial, setHoursInitial] = useState("");
  const [adding, setAdding] = useState(false);
  const [addWhere, setAddWhere] = useState("");
  const [addKind, setAddKind] = useState("");
  const [addDate, setAddDate] = useState("");
  const [addStart, setAddStart] = useState("09:00");
  const [addEnd, setAddEnd] = useState("17:00");
  const [addHours, setAddHours] = useState("");
  const [addNote, setAddNote] = useState("");
  const [addReason, setAddReason] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [reason, setReason] = useState("");
  const [billable, setBillable] = useState(true);
  const [initial, setInitial] = useState({ start: "", end: "" });
  const [sel, setSel] = useState<Sel>(null);
  const [moveWhere, setMoveWhere] = useState("");
  const [moveKind, setMoveKind] = useState("");
  const [origMove, setOrigMove] = useState({ where: "", kind: "" });
  const [moveTargets, setMoveTargets] = useState<{
    jobs: { id: string; number: string; title: string; hoursOnly?: boolean }[];
    internalJobs: { id: string; name: string }[];
  } | null>(null);

  const stateSeq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++stateSeq.current;
    const res = await fetch(`${base}/${workerId}?week=${weekStart}`, { cache: "no-store" });
    if (!res.ok || mine !== stateSeq.current) return;
    setState(((await res.json()) as { state: CrewTimeState }).state);
  }, [base, workerId, weekStart]);

  useEffect(() => {
    // Clear first, so another worker's or week's data is never shown (or acted on) under this header.
    setState(null);
    setSel(null);
    void load();
  }, [load]);

  async function act(action: "approve" | "send_back" | "unlock", done: string) {
    setBusy(true);
    const ok = await callApi(`${base}/${workerId}`, "POST", { action, weekStart, note });
    setBusy(false);
    if (!ok) return;
    toast.success(done);
    setNote("");
    await Promise.all([load(), onChanged()]);
  }

  async function saveEntry(e: CrewEntryView, extra: Record<string, unknown> = {}) {
    const body: Record<string, unknown> = { reason, ...extra };
    // Only send times that were changed, so voiding or a billable change keeps the exact seconds.
    if (e.hoursOnly) {
      if (!("voided" in extra) && hoursText.trim() !== hoursInitial) {
        const m = parseHoursInput(hoursText);
        if (m === null || m <= 0) {
          toast.error("Enter the hours, for example 4 or 2:30.");
          return;
        }
        body.durationMinutes = m;
      }
    } else {
      if (startLocal && startLocal !== initial.start) body.startAt = zonedTimeToUtc(startLocal, tz).toISOString();
      if (endLocal && endLocal !== initial.end) body.endAt = zonedTimeToUtc(endLocal, tz).toISOString();
    }
    if (!("billable" in extra) && billable !== e.billable) body.billable = billable;
    if (!("voided" in extra) && moveWhere && (moveWhere !== origMove.where || moveKind !== origMove.kind)) {
      const [type, id] = moveWhere.split(":");
      if (type === "job" && id) body.target = { type: "job", jobId: id, kind: moveKind };
      else if (type === "internal" && id) body.target = { type: "internal", internalJobId: id, kind: moveKind };
      else if (moveWhere === "general" || moveWhere === "break") body.target = { type: "none", kind: moveWhere };
    }
    const ok = await callApi(`/api/sub-accounts/${subAccountId}/field-services/time-entries/${e.id}`, "PATCH", body);
    if (!ok) return;
    toast.success("Time updated.");
    setEditing(null);
    setReason("");
    await Promise.all([load(), onChanged()]);
  }

  function openAddTime() {
    const today = zonedDateKey(new Date(), tz);
    setAddDate(today >= weekStart && today <= addDaysToKey(weekStart, 6) ? today : weekStart);
    setAddWhere("");
    setAddKind(activeTimeKinds(config?.timeKinds)[0]?.id ?? "admin");
    setAddHours("");
    setAddNote("");
    setAddReason("");
    setAdding(true);
    if (!moveTargets) {
      void fetch(`/api/sub-accounts/${subAccountId}/field-services/time-entries/targets`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setMoveTargets(d))
        .catch(() => {});
    }
  }

  const addJob = addWhere.startsWith("job:") ? moveTargets?.jobs.find((j) => `job:${j.id}` === addWhere) : undefined;
  const addIsHours = addJob?.hoursOnly === true;

  async function saveAddTime() {
    let target: Record<string, unknown> | null = null;
    const [type, id] = addWhere.split(":");
    if (type === "job" && id) target = { type: "job", jobId: id, kind: addKind };
    else if (type === "internal" && id) target = { type: "internal", internalJobId: id, kind: addKind };
    else if (addWhere === "general" || addWhere === "break") target = { type: "none", kind: addWhere };
    if (!target) {
      toast.error("Choose where this time goes.");
      return;
    }
    if (!addDate) {
      toast.error("Pick a date.");
      return;
    }
    const body: Record<string, unknown> = { action: "add_time", target, note: addNote, reason: addReason };
    if (addIsHours) {
      const m = parseHoursInput(addHours);
      if (m === null || m <= 0) {
        toast.error("Enter the hours, for example 4 or 2:30.");
        return;
      }
      body.date = addDate;
      body.minutes = m;
    } else {
      const a = zonedTimeToUtc(`${addDate}T${addStart}`, tz);
      const b = zonedTimeToUtc(`${addDate}T${addEnd}`, tz);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) {
        toast.error("Enter a start and a later end.");
        return;
      }
      body.startAt = a.toISOString();
      body.endAt = b.toISOString();
    }
    setBusy(true);
    const res = await callApi<{ warnings?: string[] }>(`${base}/${workerId}`, "POST", body);
    setBusy(false);
    if (!res) return;
    toast.success("Time added.");
    for (const w of res.warnings ?? []) toast.warning(w);
    setAdding(false);
    await Promise.all([load(), onChanged()]);
  }

  const Shell = inline ? InlineShell : DialogShell;
  const Header = inline ? PlainHeader : DialogHeader;
  const Title = inline ? PlainTitle : DialogTitle;
  const Desc = inline ? PlainDesc : DialogDescription;
  const sheet = state?.sheet;
  const locked = sheet?.status === "submitted" || sheet?.status === "approved";
  const byDay = new Map<string, CrewEntryView[]>();
  for (const e of state?.weekEntries ?? []) {
    if (!e.startAt) continue;
    const day = zonedDateKey(new Date(e.startAt), tz);
    if (sel && sel !== "all" && (sel.day !== day || sel.row !== rowKeyOf(e))) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }

  const days = Array.from({ length: 7 }, (_, i) => addDaysToKey(weekStart, i));
  const nowMs = state ? new Date(state.now).getTime() : 0;
  const gridRows = new Map<string, { label: string; type: string; kind: string; cells: Map<string, Span[]>; all: Span[] }>();
  const dayAll = new Map<string, Span[]>();
  for (const e of state?.weekEntries ?? []) {
    if (!e.startAt) continue;
    const a = new Date(e.startAt).getTime();
    const b = e.running ? nowMs : e.endAt ? new Date(e.endAt).getTime() : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    const day = zonedDateKey(new Date(a), tz);
    const key = rowKeyOf(e);
    const row = gridRows.get(key) ?? {
      label: e.label,
      type: e.target.type === "visit" ? "job" : e.target.type,
      kind: e.kind,
      cells: new Map<string, Span[]>(),
      all: [] as Span[],
    };
    row.cells.set(day, [...(row.cells.get(day) ?? []), [a, b, e.hoursOnly]]);
    row.all.push([a, b, e.hoursOnly]);
    gridRows.set(key, row);
    dayAll.set(day, [...(dayAll.get(day) ?? []), [a, b, e.hoursOnly]]);
  }
  const selStale = typeof sel === "object" && sel !== null && !gridRows.get(sel.row)?.cells.has(sel.day);
  useEffect(() => {
    if (selStale && state) setSel(null);
  }, [selStale, state]);

  const orderedRows = [...gridRows.entries()].sort(
    (x, y) => (ROW_ORDER[x[1].type] ?? 3) - (ROW_ORDER[y[1].type] ?? 3) || x[1].label.localeCompare(y[1].label) || x[1].kind.localeCompare(y[1].kind),
  );

  const grid =
    state ? (
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="px-3 py-3 text-left font-medium">{jobTerms(config).Job}</th>
              <th className="px-2 py-3 text-left font-medium">{activityTerm(config)}</th>
              {days.map((d) => (
                <th key={d} className="px-1 py-3 text-center font-medium">
                  <div className="text-foreground">
                    {formatInZone(zonedTimeToUtc(`${d}T12:00`, tz), tz, { weekday: "short" })}
                  </div>
                  <div>{formatInZone(zonedTimeToUtc(`${d}T12:00`, tz), tz, { month: "short", day: "2-digit" })}</div>
                </th>
              ))}
              <th className="px-3 py-3 text-right font-medium">Week hours</th>
            </tr>
          </thead>
          <tbody>
            {orderedRows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                  No time logged this week.
                </td>
              </tr>
            ) : (
              orderedRows.map(([key, row]) => (
                <tr key={key} className="border-b last:border-b-0">
                  <td className="max-w-[16rem] truncate px-3 py-2.5 font-medium" title={row.label}>
                    {row.label}
                  </td>
                  <td className="px-2 py-2.5 text-muted-foreground">
                    {row.type === "none" ? "–" : (kindLabelOf(config?.timeKinds, row.kind))}
                  </td>
                  {days.map((d) => {
                    const cell = row.cells.get(d);
                    const active = typeof sel === "object" && sel !== null && sel.row === key && sel.day === d;
                    return (
                      <td key={d} className="px-1 py-1.5 text-center">
                        <button
                          type="button"
                          disabled={!cell}
                          onClick={() => setSel(active ? null : { row: key, day: d })}
                          className={cn(
                            "h-8 w-full min-w-[4.5rem] rounded-md border text-xs tabular-nums",
                            cell ? "hover:bg-muted" : "cursor-default text-muted-foreground/50",
                            active && "border-primary ring-1 ring-primary",
                          )}
                        >
                          {gridDuration(cell ? unionMs(cell) : 0)}
                        </button>
                      </td>
                    );
                  })}
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums">{gridDuration(unionMs(row.all))}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="border-t bg-muted/40 text-xs">
              <td colSpan={2} className="px-3 py-3 font-medium">Total</td>
              {days.map((d) => (
                <td key={d} className="px-1 py-3 text-center tabular-nums">
                  {gridDuration(unionMs(dayAll.get(d) ?? []))}
                </td>
              ))}
              <td className="px-3 py-3 text-right text-sm font-semibold tabular-nums">{gridDuration(state.weekMs)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    ) : null;

  return (
    <Shell onClose={onClose}>
        <Header>
          <Title>
            Weekly timesheet
          </Title>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <select
              aria-label={workerTerms(config).Worker}
              value={workerId}
              onChange={(e) => {
                const w = workers.find((x) => x.workerId === e.target.value);
                if (w) onSwitch(w.workerId, w.name);
              }}
              className="h-9 rounded-md border bg-background px-2 text-sm [&_option]:bg-background [&_option]:text-foreground"
            >
              {workers.map((w) => (
                <option key={w.workerId} value={w.workerId}>
                  {w.name}
                </option>
              ))}
            </select>
            <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => onWeek(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" aria-label="Next week" disabled={!canGoNext} onClick={() => onWeek(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <>
              <span className="px-1 text-sm font-medium">{weekLabel(weekStart, tz)}</span>
              <Button variant="outline" size="sm" disabled={!canGoNext} onClick={() => onToday?.()}>
                Jump to current week
              </Button>
            </>
          </div>
          <Desc>
            {sheet ? `${name} · ${STATUS[sheet.status].label} · ${hm(state?.weekMs ?? 0)} h this week` : "Loading…"}
            {sheet?.status === "sent_back" && sheet.note ? ` · ${sheet.note}` : ""}
          </Desc>
        </Header>

        {!state ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </p>
        ) : (
          <div className="space-y-4">
            {grid}
            {Object.keys(sheet?.dayNotes ?? {}).length > 0 && (
              <div className="space-y-1 rounded-xl border p-3 text-sm">
                <p className="font-medium">Notes from {name}</p>
                {Object.entries(sheet?.dayNotes ?? {})
                  .sort(([x], [y]) => x.localeCompare(y))
                  .map(([d, n]) => (
                    <p key={d}>
                      <span className="text-muted-foreground">
                        {formatInZone(zonedTimeToUtc(`${d}T12:00`, tz), tz, { weekday: "short", day: "numeric", month: "short" })}:
                      </span>{" "}
                      {n}
                    </p>
                  ))}
              </div>
            )}
            {!locked && (
              <div className="space-y-2">
                {!adding ? (
                  <Button size="sm" variant="outline" onClick={openAddTime}>
                    Add time
                  </Button>
                ) : (
                  <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-4">
                    <div className="sm:col-span-2">
                      <Label className="mb-1 block text-xs text-muted-foreground">Project</Label>
                      <select
                        value={addWhere}
                        onChange={(ev) => setAddWhere(ev.target.value)}
                        className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm [&_option]:bg-background [&_option]:text-foreground"
                      >
                        <option value="">Choose…</option>
                        {(moveTargets?.jobs ?? []).map((j) => (
                          <option key={j.id} value={`job:${j.id}`}>
                            {j.number} {j.title}
                            {j.hoursOnly ? " (hours only)" : ""}
                          </option>
                        ))}
                        {(moveTargets?.internalJobs ?? []).map((j) => (
                          <option key={j.id} value={`internal:${j.id}`}>
                            {j.name} (internal)
                          </option>
                        ))}
                        <option value="general">General time</option>
                        <option value="break">Break</option>
                      </select>
                    </div>
                    {(addWhere.startsWith("job:") || addWhere.startsWith("internal:")) && (
                      <div className="sm:col-span-2">
                        <Label className="mb-1 block text-xs text-muted-foreground">{activityTerm(config)}</Label>
                        <select
                          value={addKind}
                          onChange={(ev) => setAddKind(ev.target.value)}
                          className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm [&_option]:bg-background [&_option]:text-foreground"
                        >
                          {activeTimeKinds(config?.timeKinds).map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <Label className="mb-1 block text-xs text-muted-foreground">Date</Label>
                      <Input type="date" value={addDate} min={weekStart} max={addDaysToKey(weekStart, 6)} onChange={(ev) => setAddDate(ev.target.value)} />
                    </div>
                    {addIsHours ? (
                      <div>
                        <Label className="mb-1 block text-xs text-muted-foreground">Hours</Label>
                        <Input value={addHours} placeholder="4 or 2:30" onChange={(ev) => setAddHours(ev.target.value)} />
                      </div>
                    ) : (
                      <>
                        <div>
                          <Label className="mb-1 block text-xs text-muted-foreground">Start</Label>
                          <Input type="time" value={addStart} onChange={(ev) => setAddStart(ev.target.value)} />
                        </div>
                        <div>
                          <Label className="mb-1 block text-xs text-muted-foreground">End</Label>
                          <Input type="time" value={addEnd} onChange={(ev) => setAddEnd(ev.target.value)} />
                        </div>
                      </>
                    )}
                    <div className="sm:col-span-2">
                      <Label className="mb-1 block text-xs text-muted-foreground">Note (optional)</Label>
                      <Input value={addNote} maxLength={500} onChange={(ev) => setAddNote(ev.target.value)} />
                    </div>
                    <div className="sm:col-span-2">
                      <Label className="mb-1 block text-xs text-muted-foreground">Why (kept in the history)</Label>
                      <Input value={addReason} maxLength={300} onChange={(ev) => setAddReason(ev.target.value)} />
                    </div>
                    <div className="flex flex-wrap gap-2 sm:col-span-4">
                      <Button size="sm" disabled={busy || !addReason.trim()} onClick={() => void saveAddTime()}>
                        Add
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setAdding(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {state.expenses.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Expenses ·{" "}
                  {expenseTotalsText(state.expenses)}
                </p>
                <ul className="divide-y rounded-lg border text-sm">
                  {state.expenses.map((e) => (
                    <li key={e.id} className="flex items-baseline justify-between gap-3 p-3">
                      <span className="min-w-0">
                        {e.description}
                        <span className="block text-xs text-muted-foreground">
                          {categoryLabel(e.category)} · {e.date}
                          {e.label ? ` · ${e.label}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoneyCode(e.currency, e.amountMinor)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap gap-2">
                {sheet?.status !== "approved" && (
                  <Button size="sm" disabled={busy} onClick={() => void act("approve", "Week approved.")}>
                    Approve week
                  </Button>
                )}
                {sheet?.status === "submitted" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !note.trim()}
                    onClick={() => void act("send_back", "Sent back.")}
                  >
                    Send back
                  </Button>
                )}
                {locked && (
                  <Button
                    size="sm"
                    variant="outline"
                    className={buttonColorClasses(config?.unlockButtonColor)}
                    disabled={busy || !note.trim()}
                    onClick={() => void act("unlock", "Week unlocked.")}
                  >
                    Unlock
                  </Button>
                )}
              </div>
              {(sheet?.status === "submitted" || locked) && (
                <div>
                  <Label className="mb-1 block text-xs text-muted-foreground">
                    Reason (needed to send back or unlock)
                  </Label>
                  <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
                </div>
              )}
              {locked && (
                <p className="text-xs text-muted-foreground">
                  To change time in this week, unlock it first. Time already on an invoice stays as it is.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {sel ? (
                <Button size="sm" variant="outline" onClick={() => setSel(null)}>
                  Hide entries
                </Button>
              ) : (
                <span>Select an hours cell to see its entries.</span>
              )}
              {sel !== "all" && (
                <Button size="sm" variant="outline" onClick={() => setSel("all")}>
                  Show all entries
                </Button>
              )}
            </div>
            {!sel ? null : byDay.size === 0 ? (
              <p className="text-sm text-muted-foreground">No time logged this week.</p>
            ) : (
              [...byDay.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([day, list]) => (
                  <div key={day}>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">
                      {formatInZone(zonedTimeToUtc(`${day}T12:00`, tz), tz, {
                        weekday: "long",
                        day: "numeric",
                        month: "short",
                      })}
                    </p>
                    <ul className="divide-y rounded-lg border text-sm">
                      {list.map((e) => {
                        const s = e.startAt ? new Date(e.startAt).getTime() : 0;
                        const end = e.endAt ? new Date(e.endAt).getTime() : null;
                        return (
                          <li key={e.id} className="space-y-2 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span>
                                {e.label} · {kindLabelOf(config?.timeKinds, e.kind)} ·{" "}
                                {e.hoursOnly
                                  ? `${hm((end ?? s) - s)} h`
                                  : formatInZone(new Date(s), tz, { hour: "numeric", minute: "2-digit" })}
                                {e.hoursOnly ? "" : e.running
                                  ? " – running"
                                  : end
                                    ? ` – ${formatInZone(new Date(end), tz, { hour: "numeric", minute: "2-digit" })} · ${hm(end - s)} h`
                                    : ""}
                                {!e.billable ? " · not billed" : ""}
                                {e.invoiced ? " · on an invoice" : ""}
                              </span>
                              {!e.running && !e.locked && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setEditing(editing === e.id ? null : e.id);
                                    const st = e.startAt && !e.hoursOnly ? utcToZonedInput(new Date(e.startAt), tz) : "";
                                    const en = e.endAt && !e.hoursOnly ? utcToZonedInput(new Date(e.endAt), tz) : "";
                                    const hrs = e.hoursOnly && e.startAt && e.endAt ? hm(new Date(e.endAt).getTime() - new Date(e.startAt).getTime()) : "";
                                    setHoursText(hrs);
                                    setHoursInitial(hrs);
                                    setStartLocal(st);
                                    setEndLocal(en);
                                    setInitial({ start: st, end: en });
                                    setBillable(e.billable);
                                    setReason("");
                                    const w =
                                      e.target.type === "job"
                                        ? `job:${e.target.id}`
                                        : e.target.type === "internal"
                                          ? `internal:${e.target.id}`
                                          : e.kind === "break" || e.kind === "general"
                                            ? e.kind
                                            : "";
                                    const k =
                                      w.startsWith("job:") || w.startsWith("internal:")
                                        ? e.kind
                                        : (activeTimeKinds(config?.timeKinds)[0]?.id ?? "admin");
                                    setMoveWhere(w);
                                    setMoveKind(k);
                                    setOrigMove({ where: w, kind: k });
                                    if (!moveTargets) {
                                      void fetch(`/api/sub-accounts/${subAccountId}/field-services/time-entries/targets`, { cache: "no-store" })
                                        .then((r) => (r.ok ? r.json() : null))
                                        .then((d) => d && setMoveTargets(d))
                                        .catch(() => {});
                                    }
                                  }}
                                >
                                  Edit
                                </Button>
                              )}
                            </div>
                            {editing === e.id && (
                              <div className="grid gap-2 sm:grid-cols-4">
                                {e.hoursOnly ? (
                                  <div className="sm:col-span-2">
                                    <Label className="mb-1 block text-xs text-muted-foreground">Hours</Label>
                                    <Input value={hoursText} placeholder="4 or 2:30" onChange={(ev) => setHoursText(ev.target.value)} />
                                  </div>
                                ) : (
                                  <>
                                    <div>
                                      <Label className="mb-1 block text-xs text-muted-foreground">Start</Label>
                                      <Input type="datetime-local" value={startLocal} onChange={(ev) => setStartLocal(ev.target.value)} />
                                    </div>
                                    <div>
                                      <Label className="mb-1 block text-xs text-muted-foreground">End</Label>
                                      <Input type="datetime-local" value={endLocal} onChange={(ev) => setEndLocal(ev.target.value)} />
                                    </div>
                                  </>
                                )}
                                <div className="sm:col-span-2">
                                  <Label className="mb-1 block text-xs text-muted-foreground">Project</Label>
                                  <select
                                    value={moveWhere}
                                    onChange={(ev) => setMoveWhere(ev.target.value)}
                                    className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm [&_option]:bg-background [&_option]:text-foreground"
                                  >
                                    {!origMove.where && <option value="">Keep as it is ({e.label})</option>}
                                    {origMove.where &&
                                      !(
                                        moveTargets?.jobs.some((j) => `job:${j.id}` === origMove.where) ||
                                        moveTargets?.internalJobs.some((j) => `internal:${j.id}` === origMove.where) ||
                                        origMove.where === "general" ||
                                        origMove.where === "break"
                                      ) && <option value={origMove.where}>{e.label}</option>}
                                    {(moveTargets?.jobs ?? [])
                                      .filter((j) => (j.hoursOnly === true) === e.hoursOnly)
                                      .map((j) => (
                                      <option key={j.id} value={`job:${j.id}`}>
                                        {j.number} {j.title}
                                      </option>
                                    ))}
                                    {(e.hoursOnly ? [] : (moveTargets?.internalJobs ?? [])).map((j) => (
                                      <option key={j.id} value={`internal:${j.id}`}>
                                        {j.name} (internal)
                                      </option>
                                    ))}
                                    {!e.hoursOnly && <option value="general">General time</option>}
                                    {!e.hoursOnly && <option value="break">Break</option>}
                                  </select>
                                </div>
                                {(moveWhere.startsWith("job:") || moveWhere.startsWith("internal:")) && (
                                  <div className="sm:col-span-2">
                                    <Label className="mb-1 block text-xs text-muted-foreground">{activityTerm(config)}</Label>
                                    <select
                                      value={moveKind}
                                      onChange={(ev) => setMoveKind(ev.target.value)}
                                      className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm [&_option]:bg-background [&_option]:text-foreground"
                                    >
                                      {activeTimeKinds(config?.timeKinds).map((k) => (
                                        <option key={k.id} value={k.id}>
                                          {k.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                <div className="sm:col-span-4">
                                  <Label className="mb-1 block text-xs text-muted-foreground">Why (kept in the history)</Label>
                                  <Input value={reason} onChange={(ev) => setReason(ev.target.value)} />
                                </div>
                                <label className="flex cursor-pointer items-center gap-2 text-sm sm:col-span-4">
                                  <Checkbox checked={billable} onCheckedChange={(v) => setBillable(v === true)} />
                                  Billable
                                </label>
                                <div className="flex flex-wrap gap-2 sm:col-span-4">
                                  <Button size="sm" disabled={!reason.trim()} onClick={() => void saveEntry(e)}>
                                    Save change
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={!reason.trim()}
                                    onClick={() => void saveEntry(e, { voided: true })}
                                  >
                                    Void entry
                                  </Button>
                                </div>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
            )}
          </div>
        )}
    </Shell>
  );
}

/** One worker's week, picked by worker and week ending, shown inline for the office. */
export function WorkerActivityTab() {
  const { subAccountId, isAdmin } = useSubAccount();
  const { config } = useFieldConfig();
  const base = `/api/sub-accounts/${subAccountId}/field-services/timesheets`;
  const [week, setWeek] = useState<string | null>(null);
  const [data, setData] = useState<Listing | null>(null);
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    const res = await fetch(week ? `${base}?week=${week}` : base, { cache: "no-store" });
    if (mine !== loadSeq.current) return;
    if (!res.ok) {
      setFailed(true);
      return;
    }
    setFailed(false);
    const body = (await res.json()) as Listing;
    if (mine !== loadSeq.current) return;
    setData(body);
    setWorkerId((cur) => (cur && body.rows.some((r) => r.workerId === cur) ? cur : (body.rows[0]?.workerId ?? null)));
  }, [base, week]);

  useEffect(() => {
    if (isAdmin && config?.timesheetsEnabled) void load();
  }, [isAdmin, config?.timesheetsEnabled, load]);

  if (!isAdmin) {
    return (
      <section className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        Only admins can see {workerTerms(config).worker} activity.
      </section>
    );
  }
  if (config && !config.timesheetsEnabled) {
    return (
      <section className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        {workerTerms(config).Worker} activity uses timesheets. Turn them on in Settings.
      </section>
    );
  }
  const current = data?.rows.find((r) => r.workerId === workerId);
  if (!data && failed) {
    return (
      <section className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        Couldn&apos;t load {workerTerms(config).worker} activity. Try again in a moment.
      </section>
    );
  }
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
      </p>
    );
  }
  if (!current) {
    return (
      <section className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        No {workerTerms(config).workers} yet. Add them on the {labourTerm(config)} tab.
      </section>
    );
  }
  return (
    <WeekDialog
      inline
      base={base}
      workerId={current.workerId}
      name={current.name}
      weekStart={data.weekStart}
      tz={data.timezone}
      workers={data.rows.map((r) => ({ workerId: r.workerId, name: r.name }))}
      onSwitch={(id) => setWorkerId(id)}
      onWeek={(delta) => setWeek(addDaysToKey(data.weekStart, delta * 7))}
      onToday={() => setWeek(null)}
      canGoNext={addDaysToKey(data.weekStart, 7) <= zonedDateKey(new Date(), data.timezone)}
      onClose={() => {}}
      onChanged={load}
    />
  );
}
