/** Travel allowance choices for a service, in minutes. */
export const TRAVEL_CHOICES = [0, 15, 30, 45, 60, 90, 120, 150, 180] as const;
export const MAX_TRAVEL_MINUTES = 240;

export function cleanTravelMinutes(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(MAX_TRAVEL_MINUTES, Math.round(v))) : 0;
}

/** Space two neighbouring visits need between them: one drive, covered by the larger of their allowances. */
export function travelGapMs(a: number | undefined | null, b: number | undefined | null): number {
  return Math.max(cleanTravelMinutes(a), cleanTravelMinutes(b)) * 60_000;
}

/** Whether a visit at [start, end] with its allowance sits too close to, or on top of, an existing one. */
export function tooClose(
  existing: { start: number; end: number; travelMinutes?: number | null },
  start: number,
  end: number,
  travelMinutes: number | undefined | null,
): boolean {
  const gap = travelGapMs(existing.travelMinutes, travelMinutes);
  return existing.start < end + gap && existing.end + gap > start;
}

export function travelLabel(minutes: number): string {
  if (minutes === 0) return "None";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
