import type { DayHours, TimeOff, WeeklyHours } from "@/types/field-services";

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export const DAY_LABELS: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

const WEEKDAY: DayHours = { start: "09:00", end: "17:00" };

export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  mon: WEEKDAY,
  tue: WEEKDAY,
  wed: WEEKDAY,
  thu: WEEKDAY,
  fri: WEEKDAY,
  sat: null,
  sun: null,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** Checks a week of hours. At least one day must be a working day, and each day must end after it starts. */
export function cleanWeeklyHours(raw: unknown): WeeklyHours | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Set the working hours.";
  const src = raw as Record<string, unknown>;
  const out = {} as WeeklyHours;
  let open = 0;
  for (const key of DAY_KEYS) {
    const d = src[key];
    if (d === null || d === undefined) {
      out[key] = null;
      continue;
    }
    const day = d as Partial<DayHours>;
    if (typeof day.start !== "string" || typeof day.end !== "string" || !HHMM.test(day.start) || !HHMM.test(day.end)) {
      return `Enter the ${DAY_LABELS[key]} hours as times.`;
    }
    if (toMinutes(day.end) <= toMinutes(day.start)) return `${DAY_LABELS[key]} must finish after it starts.`;
    out[key] = { start: day.start, end: day.end };
    open++;
  }
  if (open === 0) return "Choose at least one working day.";
  return out;
}

/** The worker's hours, or the default week while none are saved. */
export function hoursOf(worker?: { workingHours?: WeeklyHours | null } | null): WeeklyHours {
  return worker?.workingHours ?? DEFAULT_WEEKLY_HOURS;
}

/** Working stretch on a day (YYYY-MM-DD), in minutes from midnight. Null on a day off. */
export function hoursOnDay(hours: WeeklyHours, dayKey: string): { startMin: number; endMin: number } | null {
  const dow = new Date(`${dayKey}T12:00:00Z`).getUTCDay();
  const d = hours[DAY_KEYS[(dow + 6) % 7]];
  return d ? { startMin: toMinutes(d.start), endMin: toMinutes(d.end) } : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(v: unknown): v is string {
  return typeof v === "string" && DAY.test(v) && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime());
}

/** Checks a list of away dates. Each must end on or after the day it starts. */
export function cleanTimeOff(raw: unknown): TimeOff[] | string {
  if (!Array.isArray(raw) || raw.length > 100) return "Time off isn't valid.";
  const out: TimeOff[] = [];
  for (const r of raw) {
    const t = (r ?? {}) as Partial<TimeOff>;
    if (!validDay(t.start) || !validDay(t.end)) return "Pick a start and end date for each time off.";
    if (t.end < t.start) return "Time off must end on or after the day it starts.";
    out.push({ start: t.start, end: t.end, note: typeof t.note === "string" ? t.note.trim().slice(0, 80) : "" });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** The time off that covers a day (YYYY-MM-DD), if any. */
export function leaveOn(worker: { timeOff?: TimeOff[] } | null | undefined, dayKey: string): TimeOff | null {
  return worker?.timeOff?.find((t) => t.start <= dayKey && dayKey <= t.end) ?? null;
}

/** Working stretch on a day for this worker, counting time off as a day off. */
export function workerHoursOn(
  worker: { workingHours?: WeeklyHours | null; timeOff?: TimeOff[] } | null | undefined,
  dayKey: string,
): { startMin: number; endMin: number } | null {
  if (leaveOn(worker, dayKey)) return null;
  return hoursOnDay(hoursOf(worker), dayKey);
}
