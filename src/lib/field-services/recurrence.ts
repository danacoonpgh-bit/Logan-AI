import { zonedTimeToUtc } from "@/lib/field-services/time";

export interface RecurrenceConfig {
  active: boolean;
  unit: "week" | "month";
  every: number;
  /** First occurrence, local date YYYY-MM-DD. Weekly repeats keep this weekday; monthly keep this day number. */
  startDate: string;
  /** Local wall time HH:MM in the job's zone. */
  time: string;
  durationMinutes: number;
  workerIds: string[];
  endsOn: string | null;
  /** Occurrence dates the office cancelled, so they are not created again. */
  skipped: string[];
  /** Fingerprint of the schedule, so a run that started on an old schedule cannot create visits after a change. */
  sig?: string;
}

export type RecurrenceInput = Omit<RecurrenceConfig, "active" | "skipped">;

export function recurrenceSignature(
  cfg: Pick<RecurrenceConfig, "unit" | "every" | "startDate" | "time" | "durationMinutes" | "workerIds" | "endsOn">,
): string {
  return [cfg.unit, cfg.every, cfg.startDate, cfg.time, cfg.durationMinutes, [...cfg.workerIds].sort().join(","), cfg.endsOn ?? ""].join("|");
}

/** Repeating visits are created at most 12 months ahead. */
export const LOOKAHEAD_DAYS = 365;
export const MAX_OCCURRENCES = 520;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function parts(date: string): [number, number, number] | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return [y, mo, d];
}

function fmt(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const p = parts(date);
  if (!p) return date;
  return fmt(Date.UTC(p[0], p[1] - 1, p[2] + days));
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function validateRecurrence(
  raw: unknown,
): { ok: true; value: RecurrenceInput } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const unit = r.unit === "week" || r.unit === "month" ? r.unit : null;
  if (!unit) return { ok: false, error: "Choose weekly or monthly." };
  const every = typeof r.every === "number" ? Math.round(r.every) : NaN;
  if (!Number.isFinite(every) || every < 1 || every > 12) {
    return { ok: false, error: "Repeat every 1 to 12 weeks or months." };
  }
  const startDate = typeof r.startDate === "string" ? r.startDate : "";
  if (!parts(startDate)) return { ok: false, error: "Enter the first visit date." };
  const todayKey = new Date().toISOString().slice(0, 10);
  if (startDate < addDays(todayKey, -366 * 3) || startDate > addDays(todayKey, 366 * 3)) {
    return { ok: false, error: "The first visit should be within a few years of today." };
  }
  const time = typeof r.time === "string" ? r.time : "";
  if (!TIME.test(time)) return { ok: false, error: "Enter a start time like 09:00." };
  const duration = typeof r.durationMinutes === "number" ? Math.round(r.durationMinutes) : NaN;
  if (!Number.isFinite(duration) || duration < 15 || duration > 1_440) {
    return { ok: false, error: "A visit can last 15 minutes to 24 hours." };
  }
  const workerIds = Array.isArray(r.workerIds)
    ? [...new Set(r.workerIds.filter((w): w is string => typeof w === "string"))].slice(0, 10)
    : [];
  let endsOn: string | null = null;
  if (r.endsOn !== undefined && r.endsOn !== null && r.endsOn !== "") {
    if (typeof r.endsOn !== "string" || !parts(r.endsOn)) return { ok: false, error: "The end date isn't valid." };
    if (r.endsOn < startDate) return { ok: false, error: "The end date must be after the first visit." };
    if (r.endsOn > addDays(startDate, 5 * 366)) return { ok: false, error: "Repeats can run at most 5 years." };
    endsOn = r.endsOn;
  }
  return { ok: true, value: { unit, every, startDate, time, durationMinutes: duration, workerIds, endsOn } };
}

/** Local dates of every occurrence from `fromDate` to `toDate` inclusive, skipping cancelled ones. */
export function occurrenceDates(
  cfg: Pick<RecurrenceConfig, "unit" | "every" | "startDate" | "endsOn" | "skipped">,
  fromDate: string,
  toDate: string,
): string[] {
  const start = parts(cfg.startDate);
  if (!start) return [];
  const last = cfg.endsOn && cfg.endsOn < toDate ? cfg.endsOn : toDate;
  const skipped = new Set(cfg.skipped);
  const out: string[] = [];
  // Start near the window instead of at the first-ever date, so old schedules keep working.
  let kStart = 0;
  const from = parts(fromDate);
  if (from) {
    if (cfg.unit === "week") {
      const days = Math.floor(
        (Date.UTC(from[0], from[1] - 1, from[2]) - Date.UTC(start[0], start[1] - 1, start[2])) / 86_400_000,
      );
      kStart = Math.max(0, Math.floor(days / (7 * cfg.every)) - 1);
    } else {
      const months = (from[0] - start[0]) * 12 + (from[1] - start[1]);
      kStart = Math.max(0, Math.floor(months / cfg.every) - 1);
    }
  }
  for (let k = kStart; k < kStart + MAX_OCCURRENCES; k++) {
    let date: string;
    if (cfg.unit === "week") {
      date = fmt(Date.UTC(start[0], start[1] - 1, start[2] + k * cfg.every * 7));
    } else {
      const total = start[1] - 1 + k * cfg.every;
      const y = start[0] + Math.floor(total / 12);
      const m = (total % 12) + 1;
      date = fmt(Date.UTC(y, m - 1, Math.min(start[2], daysInMonth(y, m))));
    }
    if (date > last) break;
    if (date >= fromDate && !skipped.has(date)) out.push(date);
  }
  return out;
}

export function occurrenceStart(date: string, time: string, timeZone: string): Date {
  return zonedTimeToUtc(`${date}T${time}`, timeZone);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function describeRecurrence(
  cfg: Pick<RecurrenceConfig, "unit" | "every" | "startDate" | "time">,
): string {
  const p = parts(cfg.startDate);
  if (!p) return "";
  if (cfg.unit === "week") {
    const day = WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
    return `${cfg.every === 1 ? "Every week" : `Every ${cfg.every} weeks`} on ${day} at ${cfg.time}`;
  }
  return `${cfg.every === 1 ? "Every month" : `Every ${cfg.every} months`} on the ${ordinal(p[2])} at ${cfg.time}`;
}
