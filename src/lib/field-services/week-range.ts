import { isDayKey, mondayOf } from "@/lib/field-services/intervals";
import { addDaysToKey } from "@/lib/field-services/time";

/** The weeks an invoice run covers, as the Monday that starts each end of the range. A null start means every week up to the end. */
export interface WeekRange {
  from: string | null;
  to: string;
}

export type WeekRangeResult =
  | { ok: true; range: WeekRange | null }
  | { ok: false; error: string };

/** weekEnding is any date in the last week to include; weeks is how many to include counting back, or empty for all. */
export function parseWeekRange(weekEnding: unknown, weeks: unknown): WeekRangeResult {
  if (weekEnding === undefined || weekEnding === null || weekEnding === "") return { ok: true, range: null };
  if (!isDayKey(weekEnding)) return { ok: false, error: "Choose a valid week ending date." };
  const to = mondayOf(weekEnding);
  if (weeks === undefined || weeks === null || weeks === 0 || weeks === "") {
    return { ok: true, range: { from: null, to } };
  }
  if (typeof weeks !== "number" || !Number.isInteger(weeks) || weeks < 1 || weeks > 52) {
    return { ok: false, error: "Choose between 1 and 52 weeks." };
  }
  return { ok: true, range: { from: addDaysToKey(to, -7 * (weeks - 1)), to } };
}

export function inWeekRange(week: string, range: WeekRange | null): boolean {
  if (!range) return true;
  return week <= range.to && (range.from === null || week >= range.from);
}

function shortDate(key: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** "w/e 9 Nov" for one week, "3 Nov to 16 Nov" for several. Takes the Monday of the first and last week. */
export function periodText(firstWeek: string, lastWeek: string): string {
  const end = addDaysToKey(lastWeek, 6);
  return firstWeek === lastWeek ? `w/e ${shortDate(end)}` : `${shortDate(firstWeek)} to ${shortDate(end)}`;
}
