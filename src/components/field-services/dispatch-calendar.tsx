"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatInZone, utcToZonedInput, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import type { Visit } from "@/types/field-services";

const HOUR_PX = 56;
const MIN_BLOCK_PX = 24;

export function toDate(v: unknown): Date | null {
  const t = v as { toDate?: () => Date } | null | undefined;
  return t && typeof t.toDate === "function" ? t.toDate() : null;
}

/** Black or white text, whichever reads better on the worker's colour. */
export function readableText(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > 0.4 ? "#111827" : "#fff";
}

export interface CalendarColumn {
  key: string;
  title: string;
  subtitle?: string;
  /** The day this column shows, as YYYY-MM-DD in the workspace time zone. */
  day: string;
  today?: boolean;
  weekend?: boolean;
  visits: Visit[];
  /** The person's working stretch that day. Null is a day off; absent means no hours apply. */
  hours?: { startMin: number; endMin: number } | null;
  /** Colour for blocks that have no worker of their own. */
  color: string;
}

interface Placed {
  visit: Visit;
  startMin: number;
  endMin: number;
  lane: number;
  lanes: number;
}

function minutesIntoDay(date: Date, zone: string): number {
  const local = utcToZonedInput(date, zone);
  return Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
}

/** Overlapping visits share the column width side by side. */
function place(list: { visit: Visit; startMin: number; endMin: number }[]): Placed[] {
  const sorted = [...list].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  let laneEnds: number[] = [];
  const flush = () => {
    for (const p of cluster) p.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
    clusterEnd = -1;
  };
  for (const item of sorted) {
    if (cluster.length > 0 && item.startMin >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= item.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endMin);
    } else {
      laneEnds[lane] = item.endMin;
    }
    cluster.push({ ...item, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, item.endMin);
  }
  flush();
  return out;
}

function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "12 am";
  if (h === 12) return "12 pm";
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

export function DispatchCalendar({
  columns,
  timezone,
  zoneOf,
  colorOf,
  namesOf,
  accentOf,
  onPick,
  canMove,
  onMove,
}: {
  columns: CalendarColumn[];
  timezone: string;
  zoneOf: (jobId: string) => string;
  /** Block colour for a visit shown in a column. */
  colorOf: (visit: Visit, column: CalendarColumn) => string;
  namesOf: (visit: Visit) => string;
  /** Colour of the service on the visit, drawn as a stripe on the block. */
  accentOf?: (visit: Visit) => string | null;
  onPick: (visit: Visit, column: CalendarColumn) => void;
  /** Which visits can be dragged. */
  canMove?: (visit: Visit) => boolean;
  /** A block was dropped on a column at a new start, in minutes into that column's day. */
  onMove?: (visit: Visit, from: CalendarColumn, to: CalendarColumn, startMin: number) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  const [drag, setDrag] = useState<{ id: string; colKey: string; startMin: number; durMin: number } | null>(null);
  const dragRef = useRef<{
    visit: Visit;
    col: CalendarColumn;
    x: number;
    y: number;
    startMin: number;
    durMin: number;
    moved: boolean;
    targetKey: string;
    newStart: number;
  } | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const swallowClick = useRef(false);
  const visibleHours = useRef({ first: 0, last: 24 });
  useEffect(() => () => stopDrag.current?.(), []);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const prepared = useMemo(() => {
    return columns.map((col) => {
      const timed: { visit: Visit; startMin: number; endMin: number }[] = [];
      const anytime: Visit[] = [];
      for (const v of col.visits) {
        const s = toDate(v.scheduledStart);
        if (!s) continue;
        const zone = zoneOf(v.jobId);
        if (zonedDateKey(s, zone) !== col.day) continue;
        if (v.anytime) {
          anytime.push(v);
          continue;
        }
        const e = toDate(v.scheduledEnd);
        const startMin = minutesIntoDay(s, zone);
        // A visit that runs past midnight stops at the end of its day.
        // Wall-clock end on the same day, so a clock change mid-visit doesn't skew the block.
        const endLocal = e ? minutesIntoDay(e, zone) : startMin + 60;
        const sameDay = e ? zonedDateKey(e, zone) === col.day : true;
        const rawEnd = sameDay ? endLocal : 24 * 60;
        timed.push({ visit: v, startMin, endMin: Math.min(Math.max(rawEnd, startMin + 15), 24 * 60) });
      }
      return { col, anytime, placed: place(timed) };
    });
  }, [columns, zoneOf]);

  const all = prepared.flatMap((p) => p.placed);
  const firstHour = Math.max(0, Math.min(7, ...all.map((p) => Math.floor(p.startMin / 60))));
  const lastHour = Math.min(24, Math.max(18, ...all.map((p) => Math.ceil(p.endMin / 60))));
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const height = (lastHour - firstHour) * HOUR_PX;
  const hasAnytime = prepared.some((p) => p.anytime.length > 0);
  const nowKey = zonedDateKey(now, timezone);
  const nowMin = minutesIntoDay(now, timezone);
  const gridCols = `3.25rem repeat(${columns.length}, minmax(8.5rem, 1fr))`;
  useEffect(() => {
    visibleHours.current = { first: firstHour, last: lastHour };
  }, [firstHour, lastHour]);

  /** Mouse and pen only: a finger on the grid is scrolling, and a tap opens the visit. */
  function beginDrag(e: React.PointerEvent, p: Placed, col: CalendarColumn) {
    if (!onMove || !canMove?.(p.visit) || e.button !== 0 || e.pointerType === "touch") return;
    swallowClick.current = false;
    dragRef.current = {
      visit: p.visit,
      col,
      x: e.clientX,
      y: e.clientY,
      startMin: p.startMin,
      durMin: p.endMin - p.startMin,
      moved: false,
      targetKey: col.key,
      newStart: p.startMin,
    };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 6) return;
      d.moved = true;
      const { first, last } = visibleHours.current;
      const snapped = Math.round((d.startMin + ((ev.clientY - d.y) / HOUR_PX) * 60) / 15) * 15;
      d.newStart = Math.min(Math.max(snapped, first * 60), Math.max(first * 60, last * 60 - d.durMin));
      const hit = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n instanceof HTMLElement && n.dataset.col !== undefined);
      const key = hit instanceof HTMLElement ? hit.dataset.col : undefined;
      if (key && columns.some((c) => c.key === key)) d.targetKey = key;
      setDrag({ id: d.visit.id, colKey: d.targetKey, startMin: d.newStart, durMin: d.durMin });
    };
    const finish = (commit: boolean) => {
      stopDrag.current?.();
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d?.moved) return;
      // The release after a drag can arrive as a click, even much later after Escape. Every press clears this.
      swallowClick.current = true;
      const to = columns.find((c) => c.key === d.targetKey);
      if (commit && to && (to.key !== d.col.key || d.newStart !== d.startMin)) onMove(d.visit, d.col, to, d.newStart);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };
    stopDrag.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      stopDrag.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
  }

  return (
    <div className={cn("mt-3 overflow-x-auto rounded-xl border", drag && "select-none")}>
      <div className="min-w-max">
        <div className="sticky top-0 z-20 grid border-b bg-muted text-xs" style={{ gridTemplateColumns: gridCols }}>
          <div className="sticky left-0 z-30 bg-muted" />
          {prepared.map(({ col }) => (
            <div
              key={col.key}
              aria-current={col.today ? "date" : undefined}
              className={cn(
                "flex min-w-0 items-center gap-2 border-l px-2 py-2",
                col.today && "bg-primary/10 text-primary",
                !col.today && col.weekend && "bg-muted/60",
              )}
            >
              {col.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: col.color }} />}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{col.title}</p>
                {col.subtitle && <p className="truncate text-muted-foreground">{col.subtitle}</p>}
              </div>
            </div>
          ))}
        </div>

        {hasAnytime && (
          <div className="grid border-b bg-muted/30 text-xs" style={{ gridTemplateColumns: gridCols }}>
            <div className="sticky left-0 z-10 bg-muted px-1 py-1.5 text-right text-[10px] leading-tight text-muted-foreground">
              Any time
            </div>
            {prepared.map(({ col, anytime }) => (
              <div key={col.key} className="flex min-w-0 flex-wrap gap-1 border-l p-1">
                {anytime.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => onPick(v, col)}
                    className="max-w-full truncate rounded-md border bg-card px-1.5 py-0.5 text-left hover:bg-accent"
                    title={`${v.jobNumber} ${v.jobTitle}`}
                  >
                    {v.jobNumber} · {v.jobTitle}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="grid" style={{ gridTemplateColumns: gridCols }}>
          <div className="sticky left-0 z-10 bg-muted" style={{ height }}>
            {hours.map((h) => (
              <div key={h} className="pr-1.5 text-right text-[10px] text-muted-foreground" style={{ height: HOUR_PX }}>
                <span className="relative -top-1.5">{hourLabel(h)}</span>
              </div>
            ))}
          </div>
          {prepared.map(({ col, placed }) => (
            <div
              key={col.key}
              data-col={col.key}
              className={cn("relative border-l", col.today && "bg-primary/5", !col.today && col.weekend && "bg-muted/30")}
              style={{ height }}
            >
              {col.hours !== undefined && (
                <>
                  {(col.hours === null
                    ? [[firstHour * 60, lastHour * 60]]
                    : [
                        [firstHour * 60, Math.min(col.hours.startMin, lastHour * 60)],
                        [Math.max(col.hours.endMin, firstHour * 60), lastHour * 60],
                      ]
                  )
                    .filter(([a, b]) => b > a)
                    .map(([a, b]) => (
                      <div
                        key={a}
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 bg-muted/70"
                        style={{ top: ((a - firstHour * 60) / 60) * HOUR_PX, height: ((b - a) / 60) * HOUR_PX }}
                      />
                    ))}
                </>
              )}
              {hours.map((h, i) => (
                <div key={h} className="absolute inset-x-0 border-t border-border/60" style={{ top: i * HOUR_PX }} />
              ))}
              {col.day === nowKey && nowMin >= firstHour * 60 && nowMin <= lastHour * 60 && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-destructive"
                  style={{ top: ((nowMin - firstHour * 60) / 60) * HOUR_PX }}
                />
              )}
              {drag && drag.colKey === col.key && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0.5 z-[8] overflow-hidden rounded-md border-2 border-dashed border-primary bg-primary/15 px-1.5 py-1 text-xs font-semibold text-primary"
                  style={{
                    top: ((drag.startMin - firstHour * 60) / 60) * HOUR_PX,
                    height: Math.max(MIN_BLOCK_PX, (drag.durMin / 60) * HOUR_PX - 2),
                  }}
                >
                  {(() => {
                    const dragged = col.visits.find((x) => x.id === drag.id) ?? columns.flatMap((c) => c.visits).find((x) => x.id === drag.id);
                    const zone = dragged ? zoneOf(dragged.jobId) : timezone;
                    const at = (m: number) =>
                      formatInZone(zonedTimeToUtc(`${col.day}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, zone), zone, {
                        hour: "numeric",
                        minute: "2-digit",
                      });
                    return `${at(drag.startMin)} – ${at(drag.startMin + drag.durMin)}`;
                  })()}
                </div>
              )}
              {placed.map((p) => {
                const v = p.visit;
                const color = colorOf(v, col);
                const done = v.status === "completed";
                const top = ((p.startMin - firstHour * 60) / 60) * HOUR_PX;
                const h = Math.max(MIN_BLOCK_PX, ((p.endMin - p.startMin) / 60) * HOUR_PX - 2);
                const s = toDate(v.scheduledStart)!;
                const e = toDate(v.scheduledEnd);
                const zone = zoneOf(v.jobId);
                const time = `${formatInZone(s, zone, { hour: "numeric", minute: "2-digit" })}${
                  e ? ` – ${formatInZone(e, zone, { hour: "numeric", minute: "2-digit" })}` : ""
                }`;
                return (
                  <button
                    key={v.id}
                    onPointerDown={(e) => beginDrag(e, p, col)}
                    onClick={() => {
                      if (!swallowClick.current) onPick(v, col);
                    }}
                    className={cn(
                      "absolute z-[5] overflow-hidden rounded-md px-1.5 py-1 text-left text-xs shadow-sm ring-1 ring-background transition-opacity hover:opacity-90",
                      done && "text-foreground",
                      onMove && canMove?.(v) && "cursor-grab",
                      drag?.id === v.id && "opacity-40",
                    )}
                    style={{
                      top,
                      height: h,
                      left: `calc(${(p.lane / p.lanes) * 100}% + 2px)`,
                      width: `calc(${100 / p.lanes}% - 4px)`,
                      borderLeft: accentOf?.(v) ? `4px solid ${accentOf(v)}` : undefined,
                      backgroundColor: done ? `${color}59` : color,
                      color: done ? undefined : readableText(color),
                    }}
                    aria-haspopup="dialog"
                    aria-label={`${v.jobNumber} ${v.jobTitle}, ${v.contactName}, ${time}, ${namesOf(v) || "unassigned"}`}
                  >
                    <p className="truncate font-semibold leading-tight">
                      {v.jobNumber} · {v.jobTitle}
                    </p>
                    {h >= 40 && <p className="truncate leading-tight opacity-90">{time}</p>}
                    {h >= 58 && <p className="truncate leading-tight opacity-90">{v.contactName}</p>}
                    {h >= 76 && p.lanes === 1 && v.address && <p className="truncate leading-tight opacity-80">{v.address}</p>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
