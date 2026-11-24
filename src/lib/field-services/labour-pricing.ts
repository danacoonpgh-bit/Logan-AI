import { zonedDateKey } from "@/lib/field-services/time";
import type { JobBillingType } from "@/types/field-services";

export interface LabourEntry {
  workerId: string;
  startMs: number;
  endMs: number;
  /** Hours-only time: it has no real clock time, so it is never merged with other entries. */
  fixed?: boolean;
}

export interface LabourRate {
  hourlyMinor: number;
  /** Null when the rate card has no day rate. */
  dayMinor: number | null;
  /** Role shown next to the worker's name, e.g. Electrician. */
  role: string;
}

export interface LabourLine {
  workerId: string;
  description: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface LabourResult {
  lines: LabourLine[];
  /** Tracked hours that went onto the invoice, whichever way they were priced. */
  hours: number;
  /** Workers with billable time but no usable rate. */
  missingRate: string[];
  /** Workers billed by the day who have no day rate. */
  missingDayRate: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type DayHours = Map<string, Map<string, number>>;

/** Time that overlaps for one worker counts once, so two entries for the same hour never bill twice. */
function mergeOverlaps(entries: LabourEntry[]): LabourEntry[] {
  const byWorker = new Map<string, LabourEntry[]>();
  const merged: LabourEntry[] = [];
  for (const e of entries) {
    if (!(e.endMs > e.startMs)) continue;
    if (e.fixed) {
      merged.push(e);
      continue;
    }
    const list = byWorker.get(e.workerId) ?? [];
    list.push(e);
    byWorker.set(e.workerId, list);
  }
  for (const [workerId, list] of byWorker) {
    list.sort((a, b) => a.startMs - b.startMs);
    let cur = { workerId, startMs: list[0].startMs, endMs: list[0].endMs };
    for (const e of list.slice(1)) {
      if (e.startMs <= cur.endMs) {
        if (e.endMs > cur.endMs) cur.endMs = e.endMs;
      } else {
        merged.push(cur);
        cur = { workerId, startMs: e.startMs, endMs: e.endMs };
      }
    }
    merged.push(cur);
  }
  return merged;
}

function groupByDay(entries: LabourEntry[], timezone: string): DayHours {
  const grouped: DayHours = new Map();
  for (const e of mergeOverlaps(entries)) {
    const day = zonedDateKey(new Date(e.startMs), timezone);
    const days = grouped.get(e.workerId) ?? new Map<string, number>();
    days.set(day, (days.get(day) ?? 0) + (e.endMs - e.startMs) / 3_600_000);
    grouped.set(e.workerId, days);
  }
  return grouped;
}

/**
 * Prices logged time for one job, by the site's local days. Hourly is capped at the day rate per person per day;
 * day rate is one per day worked. `prior` is time already on a live invoice, so a day still pays at most one day rate.
 */
export function priceLabour(args: {
  billingType: JobBillingType;
  timezone: string;
  entries: LabourEntry[];
  prior?: LabourEntry[];
  rateFor: (workerId: string) => LabourRate | null;
  nameFor: (workerId: string) => string;
}): LabourResult {
  const result: LabourResult = { lines: [], hours: 0, missingRate: [], missingDayRate: [] };
  if (args.billingType === "lump_sum") return result;

  const perWorker = groupByDay(args.entries, args.timezone);
  const priorByWorker = groupByDay(args.prior ?? [], args.timezone);

  for (const [workerId, days] of perWorker) {
    const rate = args.rateFor(workerId);
    if (!rate || (rate.hourlyMinor <= 0 && (rate.dayMinor ?? 0) <= 0)) {
      result.missingRate.push(workerId);
      continue;
    }
    const dayRate = rate.dayMinor !== null && rate.dayMinor > 0 ? rate.dayMinor : null;
    const byDay = args.billingType === "day_rate" || rate.hourlyMinor <= 0;
    if (byDay && dayRate === null) {
      result.missingDayRate.push(workerId);
      continue;
    }

    const who = `${args.nameFor(workerId)}${rate.role ? ` (${rate.role})` : ""}`;
    let hourlyHours = 0;
    let dayCount = 0;
    for (const [day, raw] of days) {
      const hours = round2(raw);
      if (hours <= 0) continue;
      result.hours += hours;
      const priorHours = round2(priorByWorker.get(workerId)?.get(day) ?? 0);

      if (byDay) {
        if (priorHours <= 0) dayCount += 1;
      } else if (dayRate === null) {
        hourlyHours += hours;
      } else if (priorHours <= 0) {
        if (Math.round(hours * rate.hourlyMinor) > dayRate) dayCount += 1;
        else hourlyHours += hours;
      } else {
        const alreadyBilled = Math.round(priorHours * rate.hourlyMinor);
        if (alreadyBilled >= dayRate) continue;
        const room = dayRate - alreadyBilled;
        const thisPass = Math.round(hours * rate.hourlyMinor);
        if (thisPass > room) {
          result.lines.push({
            workerId,
            description: `Labour: ${who}, rest of day rate`,
            quantity: 1,
            unitPriceMinor: room,
          });
        } else {
          hourlyHours += hours;
        }
      }
    }

    if (hourlyHours > 0) {
      result.lines.push({
        workerId,
        description: `Labour: ${who}`,
        quantity: round2(hourlyHours),
        unitPriceMinor: rate.hourlyMinor,
      });
    }
    if (dayCount > 0 && dayRate !== null) {
      result.lines.push({
        workerId,
        description: `Labour: ${who}, day rate`,
        quantity: dayCount,
        unitPriceMinor: dayRate,
      });
    }
  }
  result.hours = round2(result.hours);
  return result;
}
