import { isInvoiced } from "@/lib/field-services/job-status";
import { addDaysToKey, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import { hoursOf, hoursOnDay, leaveOn } from "@/lib/field-services/working-hours";
import type { FieldWorker, Job, JobStatus, ServiceRequest, Visit } from "@/types/field-services";

const OPEN_JOBS: JobStatus[] = ["unscheduled", "scheduled", "in_progress", "ready_to_invoice", "action_required"];
const LIVE_VISIT = ["pending", "on_my_way", "checked_in"];
const WEEK_MS = 7 * 24 * 3_600_000;

function when(v: unknown): Date | null {
  const t = v as { toDate?: () => Date } | null | undefined;
  return t && typeof t.toDate === "function" ? t.toDate() : null;
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export interface PersonLoad {
  id: string;
  name: string;
  color: string;
  bookedMin: number;
  availableMin: number;
}

export interface DashboardMetrics {
  openJobs: number;
  toSchedule: number;
  readyToInvoice: number;
  late: number;
  unassigned: number;
  staffActive: number;
  staffAway: number;
  bookedMin: number;
  availableMin: number;
  /** Booked over available for the next 7 days, or null when nobody has hours to book. */
  utilisation: number | null;
  people: PersonLoad[];
}

/** The numbers on the Field Services Home tab, worked out from what the page already has loaded. */
export function dashboardMetrics(input: {
  jobs: Job[];
  visits: Visit[];
  workers: FieldWorker[];
  requests: ServiceRequest[];
  now: Date;
  tz: string;
}): DashboardMetrics {
  const { jobs, visits, workers, requests, now, tz } = input;
  const nowMs = now.getTime();
  const endMs = nowMs + WEEK_MS;
  const today = zonedDateKey(now, tz);
  const active = workers.filter((w) => w.status === "active");

  const openJobs = jobs.filter((j) => OPEN_JOBS.includes(j.status)).length;
  const toSchedule =
    jobs.filter((j) => j.status === "unscheduled").length +
    requests.filter((r) => r.status === "new" || r.status === "action_required").length;
  const readyToInvoice = jobs.filter((j) => j.status === "ready_to_invoice" && !isInvoiced(j)).length;

  let late = 0;
  let unassigned = 0;
  for (const v of visits) {
    if (!LIVE_VISIT.includes(v.status)) continue;
    const s = when(v.scheduledStart);
    const e = when(v.scheduledEnd);
    if (!s || !e) continue;
    if (e.getTime() < nowMs && s.getTime() > nowMs - 14 * 86_400_000) late++;
    else if (v.status === "pending" && v.workerIds.length === 0 && s.getTime() >= nowMs - 86_400_000 && s.getTime() <= nowMs + 14 * 86_400_000) {
      unassigned++;
    }
  }

  const people: PersonLoad[] = active.map((w) => {
    let availableMin = 0;
    for (let d = 0; d < 7; d++) {
      const day = addDaysToKey(today, d);
      if (leaveOn(w, day)) continue;
      const h = hoursOnDay(hoursOf(w), day);
      if (!h) continue;
      const open = zonedTimeToUtc(`${day}T${hhmm(h.startMin)}`, tz).getTime();
      const close =
        h.endMin >= 24 * 60 ? zonedTimeToUtc(`${addDaysToKey(day, 1)}T00:00`, tz).getTime() : zonedTimeToUtc(`${day}T${hhmm(h.endMin)}`, tz).getTime();
      availableMin += Math.max(0, Math.min(close, endMs) - Math.max(open, nowMs)) / 60_000;
    }
    const spans: [number, number][] = [];
    for (const v of visits) {
      if (!LIVE_VISIT.includes(v.status) || !v.workerIds.includes(w.id)) continue;
      const s = when(v.scheduledStart)?.getTime();
      const e = when(v.scheduledEnd)?.getTime();
      if (s === undefined || e === undefined || e <= nowMs || s >= endMs) continue;
      spans.push([Math.max(s, nowMs), Math.min(e, endMs)]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let bookedMs = 0;
    let curStart = -1;
    let curEnd = -1;
    for (const [s, e] of spans) {
      if (s > curEnd) {
        if (curEnd > curStart) bookedMs += curEnd - curStart;
        curStart = s;
        curEnd = e;
      } else if (e > curEnd) {
        curEnd = e;
      }
    }
    if (curEnd > curStart) bookedMs += curEnd - curStart;
    return { id: w.id, name: w.name, color: w.color, bookedMin: Math.round(bookedMs / 60_000), availableMin: Math.round(availableMin) };
  });

  const bookedMin = people.reduce((n, p) => n + p.bookedMin, 0);
  const availableMin = people.reduce((n, p) => n + p.availableMin, 0);
  return {
    openJobs,
    toSchedule,
    readyToInvoice,
    late,
    unassigned,
    staffActive: active.length,
    staffAway: active.filter((w) => leaveOn(w, today)).length,
    bookedMin,
    availableMin,
    utilisation: availableMin > 0 ? Math.round((bookedMin / availableMin) * 100) : null,
    people: people.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
