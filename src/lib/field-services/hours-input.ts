/** "2:30", "2.5", "2h30", "90m" or "" as minutes. Null when it isn't an amount of time. */
export function parseHoursInput(text: string): number | null {
  const t = text.trim().toLowerCase().replace(",", ".");
  if (t === "" || t === "-" || t === "–") return 0;
  let m: number | null = null;
  let hit: RegExpExecArray | null;
  if ((hit = /^(\d{1,2}):([0-5]?\d)$/.exec(t))) m = Number(hit[1]) * 60 + Number(hit[2]);
  else if ((hit = /^(\d{1,2})h\s*(?:([0-5]?\d)m?)?$/.exec(t))) m = Number(hit[1]) * 60 + Number(hit[2] ?? 0);
  else if ((hit = /^(\d+)m$/.exec(t))) m = Number(hit[1]);
  else if ((hit = /^(\d{1,2}(?:\.\d+)?)$/.exec(t))) m = Math.round(Number(hit[1]) * 60);
  return m !== null && m <= 1_440 ? m : null;
}

/** Minutes as h:mm. */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
