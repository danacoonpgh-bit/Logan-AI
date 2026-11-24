import { addDaysToKey } from "@/lib/field-services/time";

/** [startMs, endMs], with a third true for hours-only time, which has no real clock time and is always added on top. */
export type Span = [number, number, boolean?];

/** Total length of the intervals with any overlap counted once; hours-only spans are summed as they are. */
export function unionMs(intervals: Span[]): number {
  let fixed = 0;
  for (const iv of intervals) {
    if (iv[2] === true && Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[1] > iv[0]) fixed += iv[1] - iv[0];
  }
  const sorted = intervals
    .filter((iv) => iv[2] !== true)
    .map((iv) => [iv[0], iv[1]] as [number, number])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = 0;
  let curEnd = 0;
  let open = false;
  for (const [s, e] of sorted) {
    if (!open) {
      curStart = s;
      curEnd = e;
      open = true;
    } else if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (open) total += curEnd - curStart;
  return total + fixed;
}

/** Monday of the week that contains a YYYY-MM-DD day. */
export function mondayOf(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDaysToKey(dayKey, -((dow + 6) % 7));
}

export function isDayKey(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
