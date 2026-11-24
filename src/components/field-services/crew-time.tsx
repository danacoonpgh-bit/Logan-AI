"use client";

import { parseHoursInput } from "@/lib/field-services/hours-input";
import { activeTimeKinds, kindLabelOf } from "@/lib/field-services/time-kinds";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps } from "react";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Coffee, Loader2, Lock, Play, Plus, Receipt, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Pill } from "@/components/field-services/field-ui";
import { Field, FieldSelect } from "@/components/field-booking/public-fields";
import { EXPENSE_CATEGORIES, categoryLabel, expenseTotalsText } from "@/lib/field-services/expense-categories";
import { formatMoneyCode, minorToUnit, parseDecimalInput, unitToMinor } from "@/lib/field-services/money";
import { mondayOf } from "@/lib/field-services/intervals";
import { addDaysToKey, applyClock24, formatInZone, utcToZonedInput, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import { buttonColorClasses } from "@/lib/field-services/button-colors";
import { PROJECT_KIND_STYLE, type ProjectKind } from "@/lib/field-services/project-kind";
import { jobTerms, withArticle, activityTerm } from "@/lib/field-services/terms";
import { cn } from "@/lib/utils";
import type { CrewEntryView, CrewTimeState, WeekRow } from "@/lib/server/field-crew-time-service";
import type { CrewExpenseView } from "@/lib/server/field-expenses-service";
import type { TimeTargets } from "@/lib/server/field-time-targets-service";

/** Faint tint and coloured edge for a project's type, matching the My day cards. */
function kindLook(kind: ProjectKind | null | undefined): string {
  if (!kind) return "";
  const k = PROJECT_KIND_STYLE[kind];
  return `border-l-4 ${k.edge} ${k.tint}`;
}

const NO_TARGETS: TimeTargets = { jobs: [], internalJobs: [] };

const POLL_MS = 15_000;
const BIG = "h-12 w-full touch-manipulation text-base";
const CHANGED_EVENT = "field-time-changed";
const TIMER_EVENT = "field-timer";
// Keeps iPad from zooming in when a field is focused.
const NO_ZOOM = "md:text-base";
const SELECT_BOX =
  "h-12 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground";
const SHEET_CONTENT =
  "max-h-[90dvh] overflow-y-auto pb-0 sm:max-w-md [&_[data-slot=dialog-close]]:size-11";
const SHEET_FOOTER = "sticky bottom-0 z-10 mb-0 gap-2 bg-card";
const DURATIONS: [string, number][] = [
  ["30m", 30],
  ["1h", 60],
  ["2h", 120],
  ["4h", 240],
  ["8h", 480],
];

type PillTone = ComponentProps<typeof Pill>["tone"];
const WEEK_STATUS: Record<string, [string, PillTone]> = {
  approved: ["Approved", "good"],
  submitted: ["Submitted", "warn"],
  sent_back: ["Sent back", "bad"],
  open: ["Not submitted", "neutral"],
};

interface QueuedAdd {
  clientId: string;
  body: Record<string, unknown>;
}

function hm(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function clock(startIso: string | null, nowMs: number): string {
  if (!startIso) return "0:00:00";
  const s = Math.max(0, Math.floor((nowMs - new Date(startIso).getTime()) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The only parts that re-render every second, so the rest of the screen stays still. */
function RunningClock({ startAt }: { startAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{clock(startAt, now)}</>;
}

function LiveDuration({ startMs }: { startMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{hm(now - startMs)}</>;
}

/** A labelled select with option groups, which FieldSelect does not support. */
function GroupedSelect({
  label,
  value,
  onChange,
  options,
  groupNames,
  placeholder,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; group: string }[];
  groupNames: string[];
  placeholder?: string;
  children?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block text-sm text-muted-foreground">
        {label}
      </Label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_BOX}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {groupNames.map((g) => {
          const items = options.filter((o) => o.group === g);
          return items.length ? (
            <optgroup key={g} label={g}>
              {items.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
        {children}
      </select>
    </div>
  );
}

/** A compact list with group headings, for choosing where time goes. The phone's own dropdown cannot be tightened. */
function GroupedList({
  label,
  value,
  onChange,
  options,
  groupNames,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; group: string }[];
  groupNames: string[];
}) {
  return (
    <div>
      <p className="mb-1.5 text-sm text-muted-foreground">{label}</p>
      <div role="radiogroup" aria-label={label} className="max-h-56 overflow-y-auto overscroll-contain rounded-lg border">
        {groupNames.map((g) => {
          const items = options.filter((o) => o.group === g);
          if (!items.length) return null;
          return (
            <div key={g}>
              <p className="bg-muted/40 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g}</p>
              {items.map((o) => {
                const on = o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onChange(o.value)}
                    className={cn(
                      "flex min-h-10 w-full touch-manipulation items-center justify-between gap-2 border-t px-3 py-1.5 text-left text-sm leading-snug first:border-t-0 active:bg-muted",
                      on && "bg-muted font-medium",
                    )}
                  >
                    <span className="min-w-0">{o.label}</span>
                    {on && <Check className="h-4 w-4 shrink-0" aria-hidden />}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A few short choices shown as chips. */
function ChipChoice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div>
      <p className="mb-1.5 text-sm text-muted-foreground">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === value}
            onClick={() => onChange(v)}
            className={cn(
              "min-h-10 touch-manipulation rounded-full border px-4 text-sm active:bg-muted",
              v === value && "border-foreground bg-foreground text-background",
            )}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function newClientId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

function readQueue(key: string): QueuedAdd[] {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as QueuedAdd[]).slice(0, 50) : [];
  } catch {
    return [];
  }
}

function writeQueue(key: string, list: QueuedAdd[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, 50)));
  } catch {
    /* storage unavailable: the entry is simply not kept */
  }
}

type Where = string; // "job:<id>" | "internal:<id>" | "break" | "general"

interface Sheet {
  entryId: string | null;
  where: Where;
  kind: string;
  date: string;
  start: string;
  end: string;
  /** Typed hours when the workspace only asks for hours. */
  hours: string;
  /** An existing entry on a project that records hours only. */
  hoursEntry: boolean;
  origMinutes: number;
  note: string;
  fixedLabel: string | null;
  /** An entry on a visit stays with that visit, so its project and activity are not offered. */
  lockTarget: boolean;
  /** Where and what kind an existing entry started as, so only a real change is sent. */
  origTarget: { where: string; kind: string } | null;
  /** What an existing entry started as, so a note-only change does not resend the times. */
  orig: { date: string; start: string; end: string } | null;
}

interface ExpenseSheet {
  expenseId: string | null;
  where: string;
  origWhere: string;
  date: string;
  category: string;
  description: string;
  amount: string;
  /** Currency a saved claim is in, used while its job is unchanged. */
  savedCurrency: string | null;
  /** Reused on every Save so a retry can't add the claim twice. */
  clientId: string;
}

/** One day's hours for one row, typed straight into the week table. */
function HoursCell({
  ms,
  label,
  onCommit,
  disabled,
}: {
  ms: number;
  label: string;
  onCommit: (minutes: number) => Promise<boolean>;
  disabled?: boolean;
}) {
  const shown = ms > 0 ? hm(ms) : "";
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  async function commit() {
    const minutes = parseHoursInput(text);
    if (minutes === null) {
      setText(shown);
      toast.error("Enter hours like 2:30 or 2.5.");
      return;
    }
    if (minutes === Math.round(ms / 60_000)) {
      setText(shown);
      return;
    }
    if (!(await onCommit(minutes))) setText(shown);
  }
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      disabled={disabled}
      value={text}
      placeholder="–"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setText(shown);
          e.currentTarget.blur();
        }
      }}
      className="h-9 w-16 rounded-md border border-transparent bg-transparent text-center tabular-nums hover:border-input focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

/** The row that is always at the bottom of the week table: pick the project and kind, then type hours on a day. */
function BlankRow({
  options,
  kindsFor,
  activityLabel,
  week,
  jobLabel,
  onSetHours,
}: {
  options: { value: string; label: string; group: string }[];
  kindsFor: (where: string) => [string, string][];
  activityLabel: string;
  week: { date: string }[];
  jobLabel: string;
  onSetHours: (row: WeekRow, date: string, minutes: number) => Promise<boolean>;
}) {
  const [where, setWhere] = useState("");
  const [pickedKind, setKind] = useState("");
  const [rev, setRev] = useState(0);
  const kinds = kindsFor(where);
  const kind = kinds.some(([v]) => v === pickedKind) ? pickedKind : (kinds[0]?.[0] ?? "");
  const needsKind = where.startsWith("job:") || where.startsWith("internal:");
  const groups = [...new Set(options.map((o) => o.group))];
  const field =
    "h-9 w-full rounded-md border border-input bg-background px-2 text-sm [&_option]:bg-background [&_option]:text-foreground";

  function buildRow(): WeekRow {
    const blank = [0, 0, 0, 0, 0, 0, 0];
    if (where === "break" || where === "general") {
      return { key: `none:${where}`, label: where === "break" ? "Break" : "General time", type: "none", targetId: null, kind: where, hoursOnly: false, days: blank, totalMs: 0 };
    }
    const [type, id] = where.split(":");
    const t = type === "internal" ? "internal" : "job";
    const label = options.find((o) => o.value === where)?.label ?? where;
    return { key: `${t}:${id}:${kind}`, label, type: t, targetId: id, kind, hoursOnly: false, days: blank, totalMs: 0 };
  }

  return (
    <tr className="border-t bg-muted/20">
      <th scope="row" className="px-4 py-2 text-left font-normal">
        <select aria-label={jobLabel} value={where} onChange={(e) => setWhere(e.target.value)} className={cn(field, "max-w-[15rem]")}>
          <option value="">Choose {jobLabel.toLowerCase()}…</option>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {options
                .filter((o) => o.group === g)
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </th>
      <td className="px-2 py-2">
        {needsKind ? (
          <select aria-label={activityLabel} value={kind} onChange={(e) => setKind(e.target.value)} className={field}>
            {kinds.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-muted-foreground">{where ? "–" : ""}</span>
        )}
      </td>
      {week.map((d) => (
        <td key={`${d.date}-${rev}`} className="px-1 py-1 text-center">
          <HoursCell
            ms={0}
            disabled={!where}
            label={`New row, ${d.date}`}
            onCommit={async (minutes) => {
              const ok = await onSetHours(buildRow(), d.date, minutes);
              if (ok) {
                setWhere("");
                setRev((r) => r + 1);
              }
              return ok;
            }}
          />
        </td>
      ))}
      <td />
    </tr>
  );
}

function WeekTable({
  week,
  rows,
  tz,
  today,
  selected,
  weekMs,
  jobLabel,
  notOnJob,
  onPick,
  editable,
  onSetHours,
  options,
  kindsFor,
  kindName,
  activityLabel,
}: {
  activityLabel: string;
  kindName: (id: string) => string;
  options: { value: string; label: string; group: string }[];
  kindsFor: (where: string) => [string, string][];
  editable: boolean;
  onSetHours: (row: WeekRow, date: string, minutes: number) => Promise<boolean>;
  week: { date: string; ms: number }[];
  rows: WeekRow[];
  tz: string;
  today: string;
  selected: string;
  weekMs: number;
  jobLabel: string;
  notOnJob: string;
  onPick: (date: string) => void;
}) {
  const names = useMemo(
    () => new Map(week.map((d) => [d.date, formatInZone(zonedTimeToUtc(`${d.date}T12:00`, tz), tz, { weekday: "short" })])),
    [week, tz],
  );
  const weekday = (date: string) => names.get(date) ?? "";
  return (
    <div className="hidden overflow-x-auto border-t lg:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wider text-muted-foreground">
            <th scope="col" className="px-4 py-2 text-left font-medium">
              {jobLabel}
            </th>
            <th scope="col" className="px-2 py-2 text-left font-medium">
              {activityLabel}
            </th>
            {week.map((d) => (
              <th key={d.date} scope="col" className="px-1 py-1 font-medium">
                <button
                  type="button"
                  onClick={() => onPick(d.date)}
                  aria-pressed={d.date === selected}
                  aria-label={`${weekday(d.date)} ${Number(d.date.slice(8))}${d.date === today ? ", today" : ""}`}
                  className={cn(
                    "w-full rounded-lg px-2 py-1.5",
                    d.date === selected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                  )}
                >
                  <span className="block">{weekday(d.date)}</span>
                  <span className="block text-base normal-case tabular-nums">
                    {Number(d.date.slice(8))}
                    {d.date === today && <span className="ml-1 align-middle text-xs">&bull;</span>}
                  </span>
                </button>
              </th>
            ))}
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !editable ? (
            <tr className="border-t">
              <td colSpan={10} className="px-4 py-4 text-base text-muted-foreground">
                No time logged this week.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className={cn("border-t", r.projectKind && PROJECT_KIND_STYLE[r.projectKind].tint)}>
                <th
                  scope="row"
                  className={cn(
                    "max-w-xs border-l-4 px-4 py-2 text-left font-normal",
                    r.projectKind ? PROJECT_KIND_STYLE[r.projectKind].edge : "border-l-muted-foreground/40",
                  )}
                >
                  <span className="block truncate text-base font-semibold">{r.title || r.label}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {r.type === "job" ? r.number : r.type === "internal" ? "Internal" : notOnJob}
                  </span>
                </th>
                <td className="px-2 py-2 text-base text-muted-foreground">
                  {r.type === "none" ? "–" : kindName(r.kind)}
                </td>
                {week.map((d, i) => (
                  <td key={d.date} className={cn("px-1 py-1 text-center", d.date === selected && "bg-primary/5")}>
                    {editable && r.kind !== "visit" ? (
                      <HoursCell
                        ms={r.days[i]}
                        label={`${r.label}, ${weekday(d.date)} ${Number(d.date.slice(8))}`}
                        onCommit={(minutes) => onSetHours(r, d.date, minutes)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => onPick(d.date)}
                        tabIndex={-1}
                        aria-label={`${r.label}, ${weekday(d.date)} ${Number(d.date.slice(8))}: ${r.days[i] > 0 ? hm(r.days[i]) : "none"}`}
                        className={cn(
                          "w-full rounded-md py-1.5 tabular-nums hover:bg-muted",
                          r.days[i] === 0 && "text-muted-foreground",
                        )}
                      >
                        {r.days[i] > 0 ? hm(r.days[i]) : "–"}
                      </button>
                    )}
                  </td>
                ))}
                <td className="px-4 py-2 text-right text-base font-semibold tabular-nums">{hm(r.totalMs)}</td>
              </tr>
            ))
          )}
          {editable && <BlankRow options={options} kindsFor={kindsFor} activityLabel={activityLabel} week={week} jobLabel={jobLabel} onSetHours={onSetHours} />}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/30 font-medium">
            <th scope="row" colSpan={2} className="px-4 py-2 text-left">
              Total
            </th>
            {week.map((d) => (
              <td key={d.date} className={cn("px-1 py-2 text-center tabular-nums", d.date === selected && "bg-primary/5")}>
                {d.ms > 0 ? hm(d.ms) : "–"}
              </td>
            ))}
            <td className="px-4 py-2 text-right text-base tabular-nums">{hm(weekMs)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function CrewTime({
  endpoint,
  portal = false,
  heading,
  fab = true,
  wide = false,
}: {
  endpoint: string;
  portal?: boolean;
  heading?: string;
  /** The floating add button. Off when several of these are on one page. */
  fab?: boolean;
  /** Use the desktop layout on large screens: panels side by side and the week as a grid. */
  wide?: boolean;
}) {
  const [state, setState] = useState<(Omit<CrewTimeState, "targets"> & { targets: TimeTargets }) | null>(null);
  const targetsRef = useRef<TimeTargets | null>(null);
  const loadSeq = useRef(0);
  const [dayOpen, setDayOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState<{ date: string; text: string } | null>(null);
  const pollCount = useRef(0);
  const flushing = useRef(false);
  const [date, setDate] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [timerWhere, setTimerWhere] = useState<Where>("");
  const [timerKind, setTimerKind] = useState("");
  const [queued, setQueued] = useState(0);
  const [tab, setTab] = useState<"time" | "expenses">("time");
  const [expenseSheet, setExpenseSheet] = useState<ExpenseSheet | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [expenseError, setExpenseError] = useState<string | null>(null);
  const [armedOut, setArmedOut] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [online, setOnline] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [, setMinute] = useState(0);
  const lastTimerSig = useRef("");
  const tz = state?.timezone ?? "UTC";
  const queueKey = state?.workerId ? `crew-time-queue:${endpoint}:${state.workerId}` : "";

  const load = useCallback(async (withTargets = false) => {
    const mine = ++loadSeq.current;
    try {
      const params = new URLSearchParams();
      if (date) params.set("date", date);
      if (withTargets || !targetsRef.current) params.set("targets", "1");
      const qs = params.toString();
      const res = await fetch(qs ? `${endpoint}?${qs}` : endpoint, { cache: "no-store" });
      if (mine !== loadSeq.current) return;
      if (res.status === 401 && portal) {
        window.location.replace(`/field/${window.location.pathname.split("/")[2] ?? ""}/login`);
        return;
      }
      if (res.status === 403 || res.status === 404) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error("bad status");
      const data = (await res.json()) as CrewTimeState;
      if (mine !== loadSeq.current) return;
      if (!data.enabled) {
        setHidden(true);
        return;
      }
      if (data.targets) targetsRef.current = data.targets;
      setState({ ...data, targets: targetsRef.current ?? NO_TARGETS });
      setFailed(false);
      setLastUpdated(Date.now());
    } catch {
      setFailed(true);
    }
  }, [endpoint, date, portal]);

  const flush = useCallback(async () => {
    if (!queueKey || flushing.current) return;
    flushing.current = true;
    try {
      const list = readQueue(queueKey);
      if (list.length === 0) {
        setQueued(0);
        return;
      }
      const done = new Set<string>();
      let sent = 0;
      for (const item of list) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(item.body),
          });
          if (res.ok) {
            sent++;
            done.add(item.clientId);
          } else if (res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403) {
            // Not signed in, or the server is busy: keep the rest for next time.
            break;
          } else {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            const when = typeof item.body.startAt === "string"
              ? formatInZone(new Date(item.body.startAt), tz, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
              : "";
            toast.error(`The time you saved${when ? ` for ${when}` : ""} couldn't be added: ${data.error ?? "it was refused"}. Add it again if it is still needed.`);
            done.add(item.clientId);
          }
        } catch {
          break;
        }
      }
      // Re-read, so an entry saved while this ran is not lost.
      const remaining = readQueue(queueKey).filter((q) => !done.has(q.clientId));
      writeQueue(queueKey, remaining);
      setQueued(remaining.length);
      if (sent > 0) {
        toast.success(sent === 1 ? "Saved time added." : `${sent} saved entries added.`);
        void load();
      }
    } finally {
      flushing.current = false;
    }
  }, [endpoint, queueKey, load, tz]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      pollCount.current += 1;
      // Bookable jobs change rarely, so they are refreshed every few minutes rather than every poll.
      void load(pollCount.current % 12 === 0);
      void flush();
    }, POLL_MS);
    // Focus and visibility both fire when the app comes back, so the second one is skipped.
    let lastBack = 0;
    const onBack = () => {
      if (document.visibilityState !== "visible") return;
      const t = Date.now();
      if (t - lastBack < 2000) return;
      lastBack = t;
      void load();
      void flush();
    };
    const onChange = () => void load();
    const onOnline = () => {
      setOnline(true);
      void flush();
      void load();
    };
    const onOffline = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener(CHANGED_EVENT, onChange);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      clearInterval(poll);
      window.removeEventListener(CHANGED_EVENT, onChange);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [load, flush]);

  // A slow tick so the "today" label moves over at midnight without a per-second render.
  useEffect(() => {
    const t = setInterval(() => setMinute((m) => m + 1), 60_000);
    return () => {
      clearInterval(t);
      if (armTimer.current) clearTimeout(armTimer.current);
    };
  }, []);

  const runningId = state?.running?.id ?? null;
  const runningLabel = state?.running?.label ?? "";
  const runningStart = state?.running?.startAt ?? "";
  useEffect(() => {
    const sig = runningId ? `${runningId}|${runningLabel}` : "";
    if (lastTimerSig.current === sig) return;
    lastTimerSig.current = sig;
    window.dispatchEvent(
      new CustomEvent(TIMER_EVENT, {
        detail: { key: endpoint, timer: runningId ? { label: runningLabel, startAt: runningStart } : null },
      }),
    );
  }, [endpoint, runningId, runningLabel, runningStart]);

  useEffect(() => {
    return () => {
      if (!lastTimerSig.current) return;
      lastTimerSig.current = "";
      window.dispatchEvent(new CustomEvent(TIMER_EVENT, { detail: { key: endpoint, timer: null } }));
    };
  }, [endpoint]);

  useEffect(() => {
    if (!queueKey) return;
    setQueued(readQueue(queueKey).length);
    void flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey]);

  async function send(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        toast.error(typeof data.error === "string" ? data.error : "That didn't work.");
        return null;
      }
      return data;
    } catch {
      toast.error("No signal. Try again when you are back online.");
      return null;
    }
  }

  async function act(name: string, body: Record<string, unknown>, done?: string) {
    setBusy(name);
    const res = await send(body);
    setBusy(null);
    if (!res) return;
    if (done) toast.success(done);
    window.dispatchEvent(new Event(CHANGED_EVENT));
    await load();
  }

  async function refreshNow() {
    setRefreshing(true);
    await Promise.all([load(), flush()]);
    setRefreshing(false);
  }

  function clockOutTap() {
    if (!armedOut) {
      setArmedOut(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmedOut(false), 4000);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmedOut(false);
    void act("clock", { action: "clock_out" }, "Clocked out.");
  }

  const targets = state?.targets;
  applyClock24(state?.clock24);
  const terms = jobTerms(state);
  const jobsGroup = terms.Jobs;
  const activityLabel = activityTerm(state);

  const kindName = (id: string) => kindLabelOf(state?.timeKinds, id);
  const kindChoices: [string, string][] = activeTimeKinds(state?.timeKinds).map((k) => [k.id, k.label]);
  // A project only offers its own activities.
  const kindsFor = (where: string): [string, string][] => {
    if (!where.startsWith("job:")) return kindChoices;
    const allowed = targets?.jobs.find((j) => `job:${j.id}` === where)?.activityIds;
    const own = allowed ? kindChoices.filter(([v]) => allowed.includes(v)) : kindChoices;
    return own.length > 0 ? own : kindChoices;
  };
  const timerKinds = kindsFor(timerWhere);
  const effTimerKind = timerKinds.some(([v]) => v === timerKind) ? timerKind : (timerKinds[0]?.[0] ?? "");

  const timerOptions = useMemo(() => {
    const list: { value: Where; label: string; group: string }[] = [];
    for (const j of targets?.jobs ?? []) {
      if (j.timers) list.push({ value: `job:${j.id}`, label: `${j.number} ${j.title}`.trim(), group: jobsGroup });
    }
    for (const j of targets?.internalJobs ?? []) {
      if (j.timers) list.push({ value: `internal:${j.id}`, label: j.name, group: "Internal" });
    }
    return list;
  }, [targets, jobsGroup]);

  const options = useMemo(() => {
    const list: { value: Where; label: string; group: string }[] = [];
    for (const j of targets?.jobs ?? []) {
      list.push({ value: `job:${j.id}`, label: `${j.number} ${j.title}`.trim(), group: jobsGroup });
    }
    for (const j of targets?.internalJobs ?? []) {
      list.push({ value: `internal:${j.id}`, label: j.name, group: "Internal" });
    }
    list.push({ value: "break", label: "Break", group: "Other" });
    list.push({ value: "general", label: "General time", group: "Other" });
    return list;
  }, [targets, jobsGroup]);

  function toTarget(where: Where, kind: string): Record<string, unknown> | null {
    if (where === "break") return { type: "none", kind: "break" };
    if (where === "general") return { type: "none", kind: "general" };
    const [type, id] = where.split(":");
    if (type === "job" && id) return { type: "job", jobId: id, kind };
    if (type === "internal" && id) return { type: "internal", internalJobId: id, kind };
    return null;
  }

  async function setHours(row: WeekRow, date: string, minutes: number): Promise<boolean> {
    const target =
      row.type === "job"
        ? { type: "job", jobId: row.targetId, kind: row.kind }
        : row.type === "internal"
          ? { type: "internal", internalJobId: row.targetId, kind: row.kind }
          : { type: "none", kind: row.kind };
    const res = await send({
      action: "set_day_hours",
      target,
      date,
      minutes,
      clientId: crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    });
    if (!res) return false;
    window.dispatchEvent(new Event(CHANGED_EVENT));
    await load();
    return true;
  }

  const isDayTimer = (e: CrewEntryView) => e.kind === "general" && e.target.type === "none";

  const whereHoursOnly = (w: string) =>
    w.startsWith("job:") && targets?.jobs.find((j) => j.id === w.slice(4))?.hoursOnly === true;
  const sheetHours = sheet ? (sheet.entryId ? sheet.hoursEntry : whereHoursOnly(sheet.where)) : false;

  function openAdd() {
    if (!state) return;
    const today = zonedDateKey(new Date(), tz);
    const isToday = state.date === today;
    const nowLocal = utcToZonedInput(new Date(), tz).slice(11, 16);
    const endTime = isToday ? nowLocal : "17:00";
    const endMs = zonedTimeToUtc(`${state.date}T${endTime}`, tz).getTime();
    const startLocal = utcToZonedInput(new Date(endMs - 3_600_000), tz);
    void load(true);
    setSheetError(null);
    setSheet({
      entryId: null,
      where: options[0]?.value ?? "general",
      kind: (() => {
        const list = kindsFor(options[0]?.value ?? "general");
        return list.some(([v]) => v === "admin") ? "admin" : (list[0]?.[0] ?? "admin");
      })(),
      // Just after midnight the hour before belongs to yesterday.
      date: startLocal.slice(0, 10),
      start: startLocal.slice(11, 16),
      end: endTime,
      hours: "",
      hoursEntry: false,
      origMinutes: 0,
      note: "",
      fixedLabel: null,
      lockTarget: false,
      origTarget: null,
      orig: null,
    });
  }

  function openEdit(e: CrewEntryView) {
    if (!state || e.running || e.locked || !e.startAt || !e.endAt) return;
    setSheetError(null);
    setSheet({
      entryId: e.id,
      where: e.target.type === "job" ? `job:${e.target.id}` : e.target.type === "internal" ? `internal:${e.target.id}` : e.kind === "break" ? "break" : e.kind === "general" ? "general" : "",
      kind: e.kind,
      date: utcToZonedInput(new Date(e.startAt), tz).slice(0, 10),
      start: utcToZonedInput(new Date(e.startAt), tz).slice(11, 16),
      end: utcToZonedInput(new Date(e.endAt), tz).slice(11, 16),
      hours: hm(new Date(e.endAt).getTime() - new Date(e.startAt).getTime()),
      hoursEntry: e.hoursOnly,
      origMinutes: Math.round((new Date(e.endAt).getTime() - new Date(e.startAt).getTime()) / 60_000),
      note: e.note,
      fixedLabel: `${e.label} · ${kindName(e.kind)}`,
      lockTarget: e.target.type === "visit" || (e.target.type === "none" && e.kind !== "break" && e.kind !== "general"),
      origTarget: {
        where: e.target.type === "job" ? `job:${e.target.id}` : e.target.type === "internal" ? `internal:${e.target.id}` : e.kind === "break" ? "break" : e.kind === "general" ? "general" : "",
        kind: e.kind,
      },
      orig: {
        date: utcToZonedInput(new Date(e.startAt), tz).slice(0, 10),
        start: utcToZonedInput(new Date(e.startAt), tz).slice(11, 16),
        end: utcToZonedInput(new Date(e.endAt), tz).slice(11, 16),
      },
    });
  }

  function range(s: Sheet): { startAt: string; endAt: string } | null {
    if (!s.start || !s.end || !s.date) return null;
    const endDate = s.end <= s.start ? addDaysToKey(s.date, 1) : s.date;
    const a = zonedTimeToUtc(`${s.date}T${s.start}`, tz);
    const b = zonedTimeToUtc(`${endDate}T${s.end}`, tz);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
    return { startAt: a.toISOString(), endAt: b.toISOString() };
  }

  async function saveSheet() {
    if (!sheet) return;
    setSheetError(null);
    const hoursOnly = sheetHours;
    const mins = hoursOnly ? parseHoursInput(sheet.hours) : null;
    if (hoursOnly) {
      if (mins === null || mins <= 0) {
        setSheetError("Enter the hours, for example 4 or 2:30.");
        toast.error("Enter the hours, for example 4 or 2:30.");
        return;
      }
      if (!sheet.entryId && !sheet.date) {
        setSheetError("Pick a date.");
        return;
      }
    }
    const r = hoursOnly ? { startAt: "", endAt: "" } : range(sheet);
    if (!r) {
      setSheetError("Enter a date, a start and an end time.");
      toast.error("Enter a date, a start and an end time.");
      return;
    }
    if (sheet.entryId) {
      setBusy("sheet");
      const timesChanged = hoursOnly
        ? mins !== sheet.origMinutes
        : !sheet.orig ||
          sheet.orig.date !== sheet.date ||
          sheet.orig.start !== sheet.start ||
          sheet.orig.end !== sheet.end;
      const newTarget =
        !sheet.lockTarget && sheet.where && (sheet.where !== sheet.origTarget?.where || sheet.kind !== sheet.origTarget?.kind)
          ? toTarget(sheet.where, sheet.kind)
          : null;
      const res = await send({
        action: "edit",
        entryId: sheet.entryId,
        ...(timesChanged ? (hoursOnly ? { durationMinutes: mins } : r) : {}),
        ...(newTarget ? { target: newTarget } : {}),
        note: sheet.note,
      });
      setBusy(null);
      if (!res) return;
      toast.success("Time updated.");
      setSheet(null);
      await load();
      return;
    }
    const target = toTarget(sheet.where, sheet.kind);
    if (!target) {
      setSheetError("Choose where this time goes.");
      toast.error("Choose where this time goes.");
      return;
    }
    const body = hoursOnly
      ? { action: "add_hours", target, date: sheet.date, minutes: mins, note: sheet.note, clientId: newClientId() }
      : { action: "add", target, ...r, note: sheet.note, clientId: newClientId() };
    setBusy("sheet");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; warnings?: string[] };
      setBusy(null);
      if (!res.ok) {
        setSheetError(data.error ?? "That didn't work.");
        toast.error(data.error ?? "That didn't work.");
        return;
      }
      toast.success("Time added.");
      for (const w of data.warnings ?? []) toast.warning(w);
      setSheet(null);
      await load();
    } catch {
      setBusy(null);
      if (!queueKey) {
        toast.error("No signal. Try again when you are back online.");
        return;
      }
      const list = [...readQueue(queueKey), { clientId: String(body.clientId), body }];
      writeQueue(queueKey, list);
      setQueued(list.length);
      setSheet(null);
      toast.success("No signal. Saved on this phone and it will be added when you are back online.");
    }
  }

  function whereOf(e: CrewExpenseView): string {
    return e.target.type === "none" ? "" : `${e.target.type}:${e.target.id}`;
  }

  function currencyFor(where: string): string {
    const [type, id] = where.split(":");
    if (type === "job") return targets?.jobs.find((j) => j.id === id)?.currency ?? state?.expenseCurrency ?? "USD";
    return state?.expenseCurrency ?? "USD";
  }

  function openExpense(e?: CrewExpenseView) {
    if (!state) return;
    const today = zonedDateKey(new Date(), tz);
    void load(true);
    setExpenseError(null);
    if (e) {
      if (e.locked) return;
      setExpenseSheet({
        expenseId: e.id,
        where: whereOf(e),
        origWhere: whereOf(e),
        date: e.date,
        category: e.category,
        description: e.description,
        amount: String(minorToUnit(e.currency, e.amountMinor)),
        savedCurrency: e.currency,
        clientId: "",
      });
      return;
    }
    setExpenseSheet({
      expenseId: null,
      where: "",
      origWhere: "",
      date: state.date > today ? today : state.date,
      category: "fuel",
      description: "",
      amount: "",
      savedCurrency: null,
      clientId: newClientId(),
    });
  }

  function sheetCurrency(x: ExpenseSheet): string {
    return x.expenseId && x.savedCurrency && x.where === x.origWhere ? x.savedCurrency : currencyFor(x.where);
  }

  async function saveExpense() {
    if (!expenseSheet) return;
    setExpenseError(null);
    const unit = parseDecimalInput(expenseSheet.amount);
    if (unit === null || unit <= 0) {
      setExpenseError("Enter the amount you paid.");
      toast.error("Enter the amount you paid.");
      return;
    }
    if (!expenseSheet.description.trim()) {
      setExpenseError("Add a short description of what you bought.");
      toast.error("Add a short description of what you bought.");
      return;
    }
    const currency = sheetCurrency(expenseSheet);
    const [type, id] = expenseSheet.where.split(":");
    const target = type && id ? { type, id } : { type: "none" };
    const common = {
      date: expenseSheet.date,
      category: expenseSheet.category,
      description: expenseSheet.description.trim(),
      amountMinor: unitToMinor(currency, unit),
    };
    setBusy("expense");
    const res = expenseSheet.expenseId
      ? await send({
          action: "edit_expense",
          expenseId: expenseSheet.expenseId,
          ...common,
          ...(expenseSheet.where !== expenseSheet.origWhere ? { target } : {}),
        })
      : await send({ action: "add_expense", ...common, target, clientId: expenseSheet.clientId });
    setBusy(null);
    if (!res) return;
    toast.success(expenseSheet.expenseId ? "Expense updated." : "Expense added.");
    setExpenseSheet(null);
    await load();
  }

  async function removeExpense() {
    if (!expenseSheet?.expenseId) return;
    setBusy("expense");
    const res = await send({ action: "void_expense", expenseId: expenseSheet.expenseId });
    setBusy(null);
    if (!res) return;
    toast.success("Expense removed.");
    setExpenseSheet(null);
    await load();
  }

  async function removeSheet() {
    if (!sheet?.entryId) return;
    setBusy("sheet");
    const res = await send({ action: "void", entryId: sheet.entryId });
    setBusy(null);
    if (!res) return;
    toast.success("Entry removed.");
    setSheet(null);
    await load();
  }

  if (hidden) return null;
  if (!state) {
    if (failed) {
      return (
        <p role="alert" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          Couldn&apos;t load your time.{" "}
          <button className="min-h-11 touch-manipulation px-2 text-sm underline" onClick={() => void load()}>
            Try again
          </button>
        </p>
      );
    }
    return (
      <div role="status" className="space-y-4" aria-busy="true" aria-label="Loading your time">
        <div className="h-12 animate-pulse rounded-xl bg-muted" />
        <div className="h-40 animate-pulse rounded-2xl bg-muted" />
        <div className="h-28 animate-pulse rounded-2xl bg-muted" />
        <div className="h-28 animate-pulse rounded-2xl bg-muted" />
      </div>
    );
  }

  const today = zonedDateKey(new Date(), tz);
  const running = state.running;
  const clockedIn = state.workday.active;
  const dayLabel =
    state.date === today
      ? "Today"
      : formatInZone(zonedTimeToUtc(`${state.date}T12:00`, tz), tz, { weekday: "long", day: "numeric", month: "short" });
  const weekMs = state.weekMs;
  const weekSheet = state.sheet;
  const sheetLocked = weekSheet.status === "submitted" || weekSheet.status === "approved";
  const [statusLabel, statusTone] = WEEK_STATUS[weekSheet.status] ?? WEEK_STATUS.open;
  const shortNames = new Map(
    state.week.map((d) => [d.date, formatInZone(zonedTimeToUtc(`${d.date}T12:00`, tz), tz, { weekday: "short" })]),
  );
  const rangeLabel = `${formatInZone(zonedTimeToUtc(`${weekSheet.weekStart}T12:00`, tz), tz, { day: "numeric", month: "short" })} – ${formatInZone(
    zonedTimeToUtc(`${addDaysToKey(weekSheet.weekStart, 6)}T12:00`, tz),
    tz,
    { day: "numeric", month: "short" },
  )}`;
  const expenseLockText =
    weekSheet.status === "approved"
      ? "The office approved this week, so expenses are locked. Ask the office to unlock it if you need to change them."
      : "This week is submitted, so expenses are locked. Withdraw it on the Time tab to change them.";

  const dayPanel = (
    <>
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-base font-medium">{dayLabel}</h3>
            <p className="text-sm text-muted-foreground">{hm(state.dayMs)} h</p>
          </div>
          {state.entries.length === 0 ? (
            <p className="text-base text-muted-foreground">No time logged.</p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {state.entries.map((e) => {
                const end = e.endAt ? new Date(e.endAt).getTime() : null;
                const start = e.startAt ? new Date(e.startAt).getTime() : null;
                const editable = !e.running && !e.locked;
                return (
                  <li key={e.id}>
                    <button
                      disabled={!editable}
                      onClick={() => openEdit(e)}
                      className={cn(
                        "flex min-h-14 w-full touch-manipulation items-center gap-3 p-3 text-left active:bg-muted disabled:active:bg-transparent",
                        kindLook(e.projectKind),
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-base font-semibold">{e.title || e.label}</p>
                        <p className="truncate text-sm text-muted-foreground">
                          {e.number ? `${e.number} · ` : ""}
                          {kindName(e.kind)}
                          {e.startAt && (!e.hoursOnly || e.running)
                            ? ` · ${formatInZone(new Date(e.startAt), tz, { hour: "numeric", minute: "2-digit" })}`
                            : ""}
                          {e.running
                            ? " – now"
                            : e.endAt && !e.hoursOnly
                              ? ` – ${formatInZone(new Date(e.endAt), tz, { hour: "numeric", minute: "2-digit" })}`
                              : ""}
                          {e.invoiced ? " · on an invoice" : e.locked ? " · locked" : ""}
                        </p>
                        {(e.flagged || e.autoClosed) && (
                          <p className="text-sm text-amber-700 dark:text-amber-400">
                            {e.autoClosed ? "Stopped automatically. Please check it." : "Check this entry."}
                          </p>
                        )}
                      </div>
                      <span className="tabular-nums text-base">
                        {e.running && start !== null ? (
                          <LiveDuration startMs={start} />
                        ) : start !== null && end !== null ? (
                          hm(end - start)
                        ) : (
                          ""
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <Button className={BIG} variant="outline" disabled={busy !== null || sheetLocked} onClick={openAdd}>
            <Plus className="mr-2 h-4 w-4" /> Add missed time
          </Button>
          <div className="space-y-1.5">
            <Label htmlFor={`day-note-${state.date}`}>Note for this day</Label>
            <textarea
              id={`day-note-${state.date}`}
              rows={3}
              maxLength={500}
              disabled={sheetLocked}
              placeholder={sheetLocked ? "This week is locked." : "Anything the office should know about this day"}
              className="w-full rounded-xl border bg-background p-3 text-base disabled:opacity-60"
              value={noteDraft?.date === state.date ? noteDraft.text : (weekSheet.dayNotes?.[state.date] ?? "")}
              onChange={(e) => setNoteDraft({ date: state.date, text: e.target.value })}
              onBlur={() => {
                const saved = weekSheet.dayNotes?.[state.date] ?? "";
                if (noteDraft?.date === state.date && noteDraft.text.trim() !== saved.trim()) {
                  const text = noteDraft.text;
                  setNoteDraft(null);
                  void act("note", { action: "set_day_note", date: state.date, note: text });
                } else if (noteDraft?.date === state.date) {
                  setNoteDraft(null);
                }
              }}
            />
          </div>
          <p className="text-sm text-muted-foreground">Times are in {tz}.</p>
    </>
  );

  return (
    <section className={cn("space-y-4", fab && "pb-16", wide && "lg:pb-0")}>
      {heading && <h2 className="text-lg font-semibold">{heading}</h2>}
      {(failed || !online) && (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400"
        >
          {online
            ? "No connection. What you see may be out of date, and clock and timer taps need a signal."
            : "You are offline. What you see may be out of date, and clock and timer taps need a signal."}
        </p>
      )}
      {queued > 0 && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {queued} saved entr{queued === 1 ? "y" : "ies"} waiting to be added. They send automatically when you have signal.
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {lastUpdated ? `Updated ${formatInZone(new Date(lastUpdated), tz, { hour: "numeric", minute: "2-digit" })}` : ""}
        </p>
        <button
          type="button"
          aria-label="Refresh"
          disabled={refreshing}
          onClick={() => void refreshNow()}
          className="flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-xl text-muted-foreground active:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </button>
      </div>

      <div role="group" aria-label="Time or expenses" className="grid grid-cols-2 gap-1 rounded-xl bg-muted/50 p-1">
        {(["time", "expenses"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "min-h-11 touch-manipulation rounded-lg text-base font-medium transition-colors",
              tab === t ? "bg-background shadow-sm" : "text-muted-foreground",
            )}
          >
            {t === "time" ? "Time" : "Expenses"}
          </button>
        ))}
      </div>

      {tab === "expenses" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-2xl border bg-card p-3 shadow-sm">
            <button
              className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl border bg-background active:bg-muted"
              aria-label="Previous week"
              onClick={() => setDate(addDaysToKey(state.date, -7))}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <p className="min-w-0 flex-1 text-center text-base font-medium">{rangeLabel}</p>
            <button
              className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl border bg-background active:bg-muted disabled:opacity-40"
              aria-label="Next week"
              disabled={addDaysToKey(mondayOf(state.date), 7) > today}
              onClick={() => {
                const next = addDaysToKey(state.date, 7);
                setDate(next >= today ? null : next);
              }}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          {sheetLocked && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400"
            >
              <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {expenseLockText}
            </p>
          )}

          <div className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">Expenses this week</p>
                <p className="break-words text-3xl font-semibold leading-tight tabular-nums">
                  {state.expenses.length > 0
                    ? expenseTotalsText(state.expenses)
                    : formatMoneyCode(state.expenseCurrency ?? "USD", 0)}
                </p>
              </div>
              <Pill tone={statusTone}>{statusLabel}</Pill>
            </div>
            <Button className={BIG} disabled={busy !== null || sheetLocked} onClick={() => openExpense()}>
              <Plus className="mr-2 h-4 w-4" /> Add expense
            </Button>
          </div>

          <div className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm">
            {state.expenses.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-4 text-center">
                <Receipt className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                <p className="text-base font-medium">No expenses this week</p>
                <p className="text-sm text-muted-foreground">
                  Fuel, materials or tools you paid for show up here once you add them.
                </p>
              </div>
            ) : (
              <ul className="divide-y rounded-xl border">
                {state.expenses.map((e) => (
                  <li key={e.id}>
                    <button
                      disabled={e.locked}
                      onClick={() => openExpense(e)}
                      className="flex min-h-14 w-full touch-manipulation items-center gap-3 p-3 text-left active:bg-muted disabled:active:bg-transparent"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-base">{e.description}</p>
                        <p className="truncate text-sm text-muted-foreground">
                          {categoryLabel(e.category)}
                          {" · "}
                          {formatInZone(zonedTimeToUtc(`${e.date}T12:00`, tz), tz, { weekday: "short", day: "numeric", month: "short" })}
                          {e.label ? ` · ${e.label}` : ""}
                          {e.locked ? " · locked" : ""}
                        </p>
                      </div>
                      {e.locked && <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Locked" />}
                      <span className="tabular-nums text-base">{formatMoneyCode(e.currency, e.amountMinor)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {state.expenses.length > 0 && weekMs === 0 && (
              <p className="text-sm text-muted-foreground">
                No time is logged this week yet, and a week needs logged time before it can be submitted.{" "}
                <button
                  type="button"
                  onClick={() => setTab("time")}
                  className="min-h-11 touch-manipulation font-medium text-primary underline underline-offset-2"
                >
                  Go to Submit week
                </button>
              </p>
            )}
            {!sheetLocked && (
              <p className="text-sm text-muted-foreground">Expenses are approved along with your weekly timesheet.</p>
            )}
          </div>
        </div>
      )}

      <div
        className={cn(
          "space-y-4",
          tab === "expenses"
            ? "hidden"
            : wide && "lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0 lg:[&>*:only-child]:col-span-2",
        )}
      >
        {(state.dayClock || clockedIn || running) && (
        <div className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm">
          {!clockedIn && !running ? (
            <>
              <p className="text-base text-muted-foreground">
                Clock in to track your day, including driving and time between {terms.jobs}.
              </p>
              <Button className={BIG} disabled={busy !== null} onClick={() => void act("clock", { action: "clock_in" }, "Clocked in.")}>
                {busy === "clock" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                Clock in
              </Button>
            </>
          ) : (
            <>
              {clockedIn && state.workday.startedAt && (
                <p className="text-sm text-muted-foreground">
                  Clocked in since{" "}
                  {formatInZone(new Date(state.workday.startedAt), tz, { hour: "numeric", minute: "2-digit" })}
                </p>
              )}
              {running ? (
                <div className="space-y-1">
                  <p className="text-base font-semibold">{running.title || running.label}</p>
                  <p className="text-sm text-muted-foreground">
                    {running.number ? `${running.number} · ` : ""}
                    {kindName(running.kind)}
                  </p>
                  <p className="font-mono text-3xl tabular-nums">
                    <RunningClock startAt={running.startAt} />
                  </p>
                </div>
              ) : (
                <p className="text-base text-muted-foreground">No timer running.</p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {running && !isDayTimer(running) && (
                  <Button
                    className={BIG}
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void act("stop", { action: "stop", entryId: running.id })}
                  >
                    <Square className="mr-2 h-4 w-4" /> Stop timer
                  </Button>
                )}
                {!clockedIn && state.dayClock && (
                  <Button className={BIG} disabled={busy !== null} onClick={() => void act("clock", { action: "clock_in" }, "Clocked in.")}>
                    <Play className="mr-2 h-4 w-4" /> Clock in
                  </Button>
                )}
                {clockedIn && !(running?.kind === "break") && (
                  <Button
                    className={BIG}
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void act("break", { action: "start", target: { type: "none", kind: "break" } })}
                  >
                    <Coffee className="mr-2 h-4 w-4" /> Start a break
                  </Button>
                )}
              </div>
              {clockedIn && (
                <div className="border-t pt-4">
                  <Button className={BIG} variant="destructive" disabled={busy !== null} onClick={clockOutTap}>
                    {armedOut ? "Tap again to clock out" : "Clock out"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
        )}

        {timerOptions.length > 0 && (
        <div className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm">
          <h3 className="text-base font-medium">Start a timer on {withArticle(terms.job)}</h3>
          <p className="text-sm text-muted-foreground">
            Starting one stops the one that is running. Timers on a visit are in My day.
          </p>
          <GroupedSelect
            label={terms.Job}
            value={timerWhere}
            onChange={setTimerWhere}
            options={timerOptions}
            groupNames={[jobsGroup, "Internal"]}
            placeholder={`Choose ${withArticle(terms.job)}…`}
          />
          <FieldSelect
            label={activityLabel}
            value={effTimerKind}
            onChange={(e) => setTimerKind(e.target.value)}
            options={timerKinds}
          />
          <Button
            className={BIG}
            disabled={busy !== null || !timerWhere}
            onClick={() => {
              const target = toTarget(timerWhere, effTimerKind);
              if (target) void act("start", { action: "start", target }, "Timer started.");
            }}
          >
            {busy === "start" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            Start timer
          </Button>
        </div>
        )}

      </div>

      <div className={cn("overflow-hidden rounded-2xl border bg-card shadow-sm", tab === "expenses" && "hidden")}>
        <div className="flex items-center gap-2 border-b bg-muted/30 p-3">
          <button
            className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl border bg-background active:bg-muted"
            aria-label="Previous week"
            onClick={() => setDate(addDaysToKey(state.date, -7))}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <p className="text-sm uppercase tracking-wider text-muted-foreground">{rangeLabel}</p>
            <p className="text-3xl font-semibold leading-tight tabular-nums">
              {hm(weekMs)}
              <span className="ml-1 text-base font-normal text-muted-foreground">h</span>
            </p>
            <div className="mt-1">
              <Pill tone={statusTone}>{statusLabel}</Pill>
            </div>
          </div>
          <button
            className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl border bg-background active:bg-muted disabled:opacity-40"
            aria-label="Next week"
            disabled={addDaysToKey(mondayOf(state.date), 7) > today}
            onClick={() => {
              const next = addDaysToKey(state.date, 7);
              setDate(next >= today ? null : next);
            }}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        <div className={cn("grid grid-cols-7 gap-1 p-2", wide && "lg:hidden")}>
          {state.week.map((d) => {
            const selected = d.date === state.date;
            const isToday = d.date === today;
            return (
              <button
                key={d.date}
                onClick={() => setDate(isToday ? null : d.date)}
                aria-pressed={selected}
                aria-label={`${formatInZone(zonedTimeToUtc(`${d.date}T12:00`, tz), tz, { weekday: "long", day: "numeric", month: "long" })}${isToday ? ", today" : ""}`}
                className={cn(
                  "relative flex min-h-[4.5rem] touch-manipulation flex-col items-center justify-between overflow-hidden rounded-xl px-1 pb-2 pt-2 text-xs transition-colors active:bg-muted",
                  selected ? "bg-primary text-primary-foreground" : "bg-muted/40",
                )}
              >
                <span className={cn("uppercase tracking-wide", selected ? "opacity-80" : "text-muted-foreground")}>
                  {(shortNames.get(d.date) ?? "").slice(0, 3)}
                </span>
                <span className="text-base font-semibold leading-none tabular-nums">
                  {Number(d.date.slice(8))}
                </span>
                <span className="tabular-nums">{d.ms > 0 ? hm(d.ms) : "–"}</span>
                {isToday && (
                  <span
                    className={cn("absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full", selected ? "bg-primary-foreground" : "bg-primary")}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div className={cn("space-y-2 border-t p-2", wide && "lg:hidden")}>
          <p className="px-1 pt-1 text-sm font-medium uppercase tracking-wider text-muted-foreground">By {terms.job}</p>
          {state.weekRows.length === 0 ? (
            <p className="px-1 pb-2 text-base text-muted-foreground">No time logged this week.</p>
          ) : (
            state.weekRows.map((r) => (
              <div
                key={r.key}
                className={cn(
                  "relative overflow-hidden rounded-xl border bg-card p-3 pl-4",
                  r.projectKind ? kindLook(r.projectKind) : "border-l-4 border-l-muted-foreground/40",
                )}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold">{r.title || r.label}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {r.type === "internal"
                        ? `Internal · ${kindName(r.kind)}`
                        : r.type === "job"
                          ? [r.number, kindName(r.kind)].filter(Boolean).join(" · ")
                          : `Not on ${withArticle(terms.job)}`}
                    </p>
                  </div>
                  <p className="shrink-0 text-lg font-semibold tabular-nums">{hm(r.totalMs)}</p>
                </div>
                <div className="mt-2 grid grid-cols-7 gap-1">
                  {state.week.map((d, i) => (
                    <button
                      key={d.date}
                      onClick={() => {
                        setDate(d.date === today ? null : d.date);
                        setDayOpen(true);
                      }}
                      aria-label={`${r.label}, ${shortNames.get(d.date) ?? ""} ${Number(d.date.slice(8))}: ${r.days[i] > 0 ? hm(r.days[i]) : "none"}`}
                      className={cn(
                        "flex min-h-11 touch-manipulation flex-col items-center justify-center rounded-lg py-1.5 text-xs tabular-nums active:bg-muted",
                        d.date === state.date ? "bg-primary/10 font-semibold" : "",
                        r.days[i] === 0 ? "text-muted-foreground/60" : "",
                      )}
                    >
                      <span className="text-xs uppercase text-muted-foreground">
                        {formatInZone(zonedTimeToUtc(`${d.date}T12:00`, tz), tz, { weekday: "narrow" })}
                      </span>
                      <span>{r.days[i] > 0 ? hm(r.days[i]) : "–"}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
        {wide && (
          <WeekTable
            week={state.week}
            rows={state.weekRows}
            editable={!sheetLocked}
            kindName={kindName}
            onSetHours={setHours}
            options={options}
            kindsFor={kindsFor}
            activityLabel={activityLabel}
            tz={tz}
            today={today}
            selected={state.date}
            weekMs={weekMs}
            jobLabel={terms.Job}
            notOnJob={`Not on ${withArticle(terms.job)}`}
            onPick={(d) => {
              setDate(d === today ? null : d);
              setDayOpen(true);
            }}
          />
        )}
      </div>

      {fab && tab === "time" && (
        <div className={cn("pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-30", wide && "lg:hidden")}>
          <div className="mx-auto flex max-w-md justify-end px-4">
            <button
              aria-label="Add time"
              disabled={busy !== null || sheetLocked}
              onClick={openAdd}
              className="pointer-events-auto flex h-14 w-14 touch-manipulation items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-black/30 transition-transform active:scale-95 disabled:opacity-40"
            >
              <Plus className="h-6 w-6" />
            </button>
          </div>
        </div>
      )}

      <div
        className={cn(
          "space-y-4",
          tab === "expenses"
            ? "hidden"
            : wide && "lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-4 lg:space-y-0",
        )}
      >
        <div
          className={cn(
            "space-y-3 rounded-2xl border bg-card p-4 shadow-sm",
            weekSheet.status === "sent_back" ? "border-amber-500/40 bg-amber-500/5" : "",
            weekSheet.status === "approved" ? "border-green-500/40 bg-green-500/5" : "",
          )}
        >
          <h3 className="text-base font-medium">
            {weekSheet.status === "approved"
              ? "Week approved"
              : weekSheet.status === "submitted"
                ? "Week submitted"
                : weekSheet.status === "sent_back"
                  ? "Week sent back"
                  : "Submit your week"}
          </h3>
          <p className="text-sm text-muted-foreground">
            {weekSheet.status === "approved"
              ? "The office approved this week. It is locked."
              : weekSheet.status === "submitted"
                ? "Waiting for the office to approve it. It is locked until then."
                : weekSheet.status === "sent_back"
                  ? `The office sent it back: ${weekSheet.note || "please check it"}. Fix it, then submit again.`
                  : weekMs === 0
                    ? "No time logged this week."
                    : running && !weekSheet.canSubmit
                      ? "Stop your timer, then you can submit."
                      : weekSheet.canSubmit
                        ? `${hm(weekMs)} h logged. When the week is done, submit it for approval.`
                          : "Nothing to submit yet."}
          </p>
          {weekSheet.status === "submitted" && (
            <Button
              className={BIG}
              variant="outline"
              disabled={busy !== null}
              onClick={() => void act("sheet", { action: "withdraw_week", weekStart: weekSheet.weekStart }, "Week withdrawn.")}
            >
              Withdraw to make changes
            </Button>
          )}
          {(weekSheet.status === "open" || weekSheet.status === "sent_back") && weekSheet.canSubmit && (
            <Button
              className={cn(BIG, buttonColorClasses(state.submitButtonColor))}
              disabled={busy !== null}
              onClick={() => void act("sheet", { action: "submit_week", weekStart: weekSheet.weekStart }, "Week submitted.")}
            >
              {busy === "sheet" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Submit week
            </Button>
          )}
        </div>

        <div className={cn("space-y-3 rounded-2xl border bg-card p-4 shadow-sm", wide && "lg:hidden")}>
          {wide || !dayOpen ? dayPanel : null}
        </div>
      </div>

      <Dialog open={dayOpen} onOpenChange={setDayOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="sr-only">{dayLabel}</DialogTitle>
            <DialogDescription className="sr-only">The time logged on this day.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">{dayPanel}</div>
        </DialogContent>
      </Dialog>

      <Dialog open={expenseSheet !== null} onOpenChange={(o) => !o && setExpenseSheet(null)}>
        <DialogContent className={SHEET_CONTENT}>
          <DialogHeader className="pr-10">
            <DialogTitle>{expenseSheet?.expenseId ? "Edit expense" : "Add expense"}</DialogTitle>
            <DialogDescription>
              A work expense you paid for. It is approved with your weekly timesheet.
            </DialogDescription>
          </DialogHeader>
          {expenseSheet && (
            <div className="space-y-3">
              <Field
                label={`Amount (${sheetCurrency(expenseSheet)})`}
                className={NO_ZOOM}
                autoFocus
                inputMode="decimal"
                enterKeyHint="done"
                value={expenseSheet.amount}
                onChange={(e) => setExpenseSheet({ ...expenseSheet, amount: e.target.value })}
              />
              <FieldSelect
                label="Category"
                value={expenseSheet.category}
                onChange={(e) => setExpenseSheet({ ...expenseSheet, category: e.target.value })}
                options={Object.entries(EXPENSE_CATEGORIES).map(([value, label]) => [value, String(label)] as [string, string])}
              />
              <Field
                label="Description"
                className={NO_ZOOM}
                value={expenseSheet.description}
                maxLength={200}
                onChange={(e) => setExpenseSheet({ ...expenseSheet, description: e.target.value })}
              />
              <Field
                label="Date"
                type="date"
                className={NO_ZOOM}
                value={expenseSheet.date}
                max={today}
                onChange={(e) => setExpenseSheet({ ...expenseSheet, date: e.target.value })}
              />
              <GroupedSelect
                label={`${terms.Job} (optional)`}
                value={expenseSheet.where}
                onChange={(v) => setExpenseSheet({ ...expenseSheet, where: v })}
                options={options}
                groupNames={[jobsGroup, "Internal"]}
                placeholder={`Not for ${withArticle(terms.job)}`}
              >
                {expenseSheet.where && !options.some((o) => o.value === expenseSheet.where) && (
                  <option value={expenseSheet.where}>Current {terms.job}</option>
                )}
              </GroupedSelect>
              {expenseError && (
                <p role="alert" className="text-sm text-destructive">
                  {expenseError}
                </p>
              )}
            </div>
          )}
          <DialogFooter className={SHEET_FOOTER}>
            {expenseSheet?.expenseId && (
              <Button variant="outline" className="h-12 touch-manipulation" disabled={busy !== null} onClick={() => void removeExpense()}>
                Remove
              </Button>
            )}
            <Button variant="outline" className="h-12 touch-manipulation" onClick={() => setExpenseSheet(null)} disabled={busy !== null}>
              Cancel
            </Button>
            <Button className="h-12 touch-manipulation" onClick={() => void saveExpense()} disabled={busy !== null}>
              {busy === "expense" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        <DialogContent className={SHEET_CONTENT}>
          <DialogHeader className="pr-10">
            <DialogTitle>{sheet?.entryId ? "Edit time" : "Add missed time"}</DialogTitle>
            <DialogDescription>
              {sheet?.entryId && !sheet.lockTarget
                ? "Change the project, activity or times if you picked the wrong one."
                : (sheet?.fixedLabel ?? "Time you worked but did not time. If it runs past midnight, it ends the next day.")}
            </DialogDescription>
          </DialogHeader>
          {sheet && (
            <div className="space-y-3">
              {(!sheet.entryId || !sheet.lockTarget) && (
                <>
                  <GroupedList
                    label="Where"
                    value={sheet.where}
                    onChange={(v) => {
                      const list = kindsFor(v);
                      setSheet({ ...sheet, where: v, kind: list.some(([k]) => k === sheet.kind) ? sheet.kind : (list[0]?.[0] ?? sheet.kind) });
                    }}
                    options={options}
                    groupNames={[jobsGroup, "Internal", "Other"]}
                  />
                  {(sheet.where.startsWith("job:") || sheet.where.startsWith("internal:")) && (
                    <ChipChoice
                      label={activityLabel}
                      value={sheet.kind}
                      onChange={(v) => setSheet({ ...sheet, kind: v })}
                      options={kindsFor(sheet.where)}
                    />
                  )}
                </>
              )}
              {(!sheetHours || !sheet.entryId) && (
                <Field
                  label="Date"
                  type="date"
                  className={NO_ZOOM}
                  value={sheet.date}
                  max={today}
                  onChange={(e) => setSheet({ ...sheet, date: e.target.value })}
                />
              )}
              {sheetHours ? (
                <>
                  <Field
                    label="Hours"
                    inputMode="decimal"
                    placeholder="4 or 2:30"
                    className={NO_ZOOM}
                    value={sheet.hours}
                    onChange={(e) => setSheet({ ...sheet, hours: e.target.value })}
                  />
                  <div className="flex flex-wrap gap-2">
                    {DURATIONS.map(([label, minutes]) => (
                      <button
                        key={label}
                        type="button"
                        className="min-h-11 touch-manipulation rounded-lg border px-4 text-sm active:bg-muted"
                        onClick={() => setSheet({ ...sheet, hours: hm(minutes * 60_000) })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
              <>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Start"
                  type="time"
                  className={NO_ZOOM}
                  value={sheet.start}
                  onChange={(e) => setSheet({ ...sheet, start: e.target.value })}
                />
                <Field
                  label="End"
                  type="time"
                  className={NO_ZOOM}
                  value={sheet.end}
                  onChange={(e) => setSheet({ ...sheet, end: e.target.value })}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {DURATIONS.map(([label, minutes]) => (
                  <button
                    key={label}
                    type="button"
                    className="min-h-11 touch-manipulation rounded-lg border px-4 text-sm active:bg-muted"
                    onClick={() => {
                      if (!sheet.start) return;
                      const startMs = zonedTimeToUtc(`${sheet.date}T${sheet.start}`, tz).getTime();
                      const endLocal = utcToZonedInput(new Date(startMs + minutes * 60_000), tz);
                      setSheet({ ...sheet, end: endLocal.slice(11, 16) });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              </>
              )}
              <Field
                label="Note (optional)"
                className={NO_ZOOM}
                value={sheet.note}
                maxLength={500}
                onChange={(e) => setSheet({ ...sheet, note: e.target.value })}
              />
              {sheetError && (
                <p role="alert" className="text-sm text-destructive">
                  {sheetError}
                </p>
              )}
            </div>
          )}
          <DialogFooter className={SHEET_FOOTER}>
            {sheet?.entryId && (
              <Button variant="outline" className="h-12 touch-manipulation" disabled={busy !== null} onClick={() => void removeSheet()}>
                Remove
              </Button>
            )}
            <Button variant="outline" className="h-12 touch-manipulation" onClick={() => setSheet(null)} disabled={busy !== null}>
              Cancel
            </Button>
            <Button className="h-12 touch-manipulation" onClick={() => void saveSheet()} disabled={busy !== null}>
              {busy === "sheet" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
