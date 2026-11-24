function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

export function zonedTimeToUtc(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return new Date(NaN);
  const wall = local.slice(0, 16);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // A repeated hour takes the first occurrence; a skipped hour lands just after the jump.
  const before = offsetMinutes(new Date(guess - 86_400_000), timeZone);
  const after = offsetMinutes(new Date(guess + 86_400_000), timeZone);
  const candidates = [guess - before * 60_000, guess - after * 60_000];
  const valid = candidates.filter(
    (t) => utcToZonedInput(new Date(t), timeZone) === wall,
  );
  return new Date(valid.length ? Math.min(...valid) : candidates[0]);
}

export function utcToZonedInput(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function zonedDateKey(instant: Date, timeZone: string): string {
  return utcToZonedInput(instant, timeZone).slice(0, 10);
}

let clock24 = false;

/** Called while a screen renders, with the workspace's setting, so every time shown after it follows it. */
export function applyClock24(on: boolean | undefined): void {
  clock24 = on === true;
}

export function clockHourCycle(): "h23" | "h12" {
  return clock24 ? "h23" : "h12";
}

export function formatInZone(
  instant: Date,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = { weekday: "short", hour: "numeric", minute: "2-digit" },
): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, hourCycle: clockHourCycle(), ...opts }).format(instant);
  } catch {
    return instant.toLocaleString();
  }
}

export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
