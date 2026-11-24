import "server-only";
import { startPointOn } from "@/lib/field-services/start-point";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatServiceAddress } from "@/lib/field-services/address";
import { isDayKey } from "@/lib/field-services/intervals";
import { addDaysToKey, formatInZone, zonedTimeToUtc } from "@/lib/field-services/time";
import { workerHoursOn } from "@/lib/field-services/working-hours";
import { cleanTravelMinutes, travelGapMs } from "@/lib/field-services/travel";
import { workspaceTimezone } from "@/lib/server/field-first-slot";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import {
  bestOrder,
  legSeconds,
  roundUp5,
  routeGate,
  type Pt,
} from "@/lib/server/field-route-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { updateVisit } from "@/lib/server/field-visits-service";
import { geocode } from "@/lib/server/geocode";
import type { FieldWorker, Job, Visit } from "@/types/field-services";

const MAX_PER_PERSON = 11;
/** Allowed for driving and a breather when checking whether a person has room for another visit. */
const DRIVE_ALLOWANCE_MS = 15 * 60_000;
const AFTER_FIXED_MS = 10 * 60_000;
const ITERATIONS = 6;

export interface PlanStop {
  visitId: string;
  title: string;
  address: string;
  startIso: string;
  endIso: string;
  startLabel: string;
  endLabel: string;
  wasWorkerName: string;
  wasLabel: string;
  changed: boolean;
  driveMinutes: number | null;
}

export interface PlanPerson {
  workerId: string;
  name: string;
  /** The suburbs or towns most of their new visits are in. */
  areas: string[];
  /** Visits that stay put (assigned by hand, started, or chosen by the customer). */
  fixedCount: number;
  driveMinutes: number;
  stops: PlanStop[];
}

export interface DayPlan {
  day: string;
  people: PlanPerson[];
  unplaced: { visitId: string; title: string; reason: string }[];
  changes: number;
}

interface Movable {
  visit: Visit & { id: string };
  pt: Pt;
  city: string;
  lengthMs: number;
  /** Travel time its service keeps free either side; zero when the visit has none recorded. */
  travelMs: number;
}

const toMs = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
};

function km(a: Pt, b: Pt): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * Gives each person one part of town for the day's flexible visits, keeps hours balanced, then orders each person's
 * visits for the least driving. Visits assigned by hand, with a customer-chosen time or under way are worked around.
 */
export async function planDay(subAccountId: string, day: string): Promise<DayPlan> {
  if (!isDayKey(day)) throw new FieldServicesError("Choose a day.");
  await routeGate(subAccountId, day);
  const back = (await getFieldServicesConfig(subAccountId)).routeReturnToBase === true;
  const db = getAdminDb();
  const timezone = await workspaceTimezone(subAccountId);
  const dayStart = zonedTimeToUtc(`${day}T00:00`, timezone).getTime();
  const dayEnd = zonedTimeToUtc(`${addDaysToKey(day, 1)}T00:00`, timezone).getTime();

  const workerSnap = await db.collection("fieldWorkers").where("subAccountId", "==", subAccountId).where("status", "==", "active").get();
  const everyone = workerSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as FieldWorker);
  const nameOf = new Map(everyone.map((w) => [w.id, w.name]));
  const people = everyone
    .map((w) => ({ w, hours: workerHoursOn(w, day) }))
    .filter((p): p is { w: FieldWorker; hours: { startMin: number; endMin: number } } => !!p.hours && !!startPointOn(p.w, day))
    .map((p) => {
      const open = zonedTimeToUtc(`${day}T${hhmm(p.hours.startMin)}`, timezone).getTime();
      const close = p.hours.endMin >= 24 * 60 ? dayEnd : zonedTimeToUtc(`${day}T${hhmm(p.hours.endMin)}`, timezone).getTime();
      return { w: p.w, open, close, home: startPointOn(p.w, day) as Pt };
    })
    .filter((p) => p.close > p.open)
    .sort((a, b) => a.w.name.localeCompare(b.w.name));
  if (people.length < 2) throw new FieldServicesError("Planning a day needs at least two people working that day with a start address.");

  const snap = await db
    .collection("visits")
    .where("subAccountId", "==", subAccountId)
    .where("scheduledStart", ">=", Timestamp.fromMillis(dayStart))
    .where("scheduledStart", "<", Timestamp.fromMillis(dayEnd))
    .get();
  const visits = snap.docs
    .map((d) => ({ ...(d.data() as Visit), id: d.id }))
    .filter((v) => v.status !== "cancelled" && v.status !== "no_show");

  const flexible = (v: Visit) =>
    v.status === "pending" &&
    !v.anytime &&
    !v.arrivalWindow &&
    (v.workerIds.length === 0 || (v.workerIds.length === 1 && v.autoScheduled === true));
  const movable = visits.filter(flexible);
  const fixed = visits.filter((v) => !flexible(v));
  if (movable.length === 0) throw new FieldServicesError("Nothing to plan: every visit that day is fixed to a person or time.");

  const jobSnaps = await db.getAll(...[...new Set(movable.map((v) => v.jobId))].map((id) => db.doc(`jobs/${id}`)));
  const jobOf = new Map(jobSnaps.map((j) => [j.id, j.data() as Job | undefined]));
  const unplaced: DayPlan["unplaced"] = [];
  const pool: Movable[] = [];
  const found = await Promise.all(
    movable.map((v) => {
      const a = jobOf.get(v.jobId)?.serviceAddress;
      return a ? geocode(formatServiceAddress(a), a.country) : geocode(v.address);
    }),
  );
  movable.forEach((v, i) => {
    const p = found[i];
    if (!p) {
      unplaced.push({ visitId: v.id, title: v.jobTitle, reason: "The address couldn't be found on the map." });
      return;
    }
    const length = Math.max(15 * 60_000, (toMs(v.scheduledEnd) ?? 0) - (toMs(v.scheduledStart) ?? 0));
    pool.push({ visit: v, pt: { lng: p.lng, lat: p.lat }, city: jobOf.get(v.jobId)?.serviceAddress?.city?.trim() || "", lengthMs: length, travelMs: cleanTravelMinutes(v.travelMinutes) * 60_000 });
  });

  // What each person already has that cannot move.
  const blocks = people.map((p) =>
    fixed
      .filter((v) => v.workerIds.includes(p.w.id))
      .map((v) => ({ s: toMs(v.scheduledStart) ?? 0, e: toMs(v.scheduledEnd) ?? 0, a: cleanTravelMinutes(v.travelMinutes) }))
      .sort((a, b) => a.s - b.s),
  );
  const room = people.map((p, i) => p.close - p.open - blocks[i].reduce((n, b) => n + Math.max(0, b.e - b.s) + b.a * 60_000, 0));

  // Groups by place: each visit goes to the nearest person's area, with busier people looking further away.
  let centers: Pt[] = people.map((p) => p.home);
  let groups: Movable[][] = people.map(() => []);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const load = people.map(() => 0);
    const count = people.map((p, i) => blocks[i].length);
    groups = people.map(() => []);
    const order = [...pool].sort((a, b) => Math.min(...centers.map((c) => km(b.pt, c))) - Math.min(...centers.map((c) => km(a.pt, c))));
    for (const m of order) {
      let best = -1;
      let bestCost = Infinity;
      people.forEach((p, i) => {
        if (load[i] + m.lengthMs + (m.travelMs || DRIVE_ALLOWANCE_MS) > room[i]) return;
        if (p.w.maxVisitsPerDay && count[i] >= p.w.maxVisitsPerDay) return;
        if (groups[i].length >= (back ? MAX_PER_PERSON - 1 : MAX_PER_PERSON)) return;
        const cost = km(m.pt, centers[i]) * (1 + load[i] / Math.max(room[i], 1));
        if (cost < bestCost) {
          bestCost = cost;
          best = i;
        }
      });
      if (best < 0) continue;
      groups[best].push(m);
      load[best] += m.lengthMs + (m.travelMs || DRIVE_ALLOWANCE_MS);
      count[best]++;
    }
    centers = people.map((p, i) => {
      const g = groups[i];
      if (g.length === 0) return p.home;
      return { lat: g.reduce((n, m) => n + m.pt.lat, 0) / g.length, lng: g.reduce((n, m) => n + m.pt.lng, 0) / g.length };
    });
  }
  const placed = new Set(groups.flat().map((m) => m.visit.id));
  for (const m of pool) {
    if (!placed.has(m.visit.id)) unplaced.push({ visitId: m.visit.id, title: m.visit.jobTitle, reason: "Nobody has room for it that day." });
  }

  // Each person's visits in the order that needs the least driving, laid out around what is already fixed.
  const out: PlanPerson[] = [];
  let changes = 0;
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    const g = groups[i];
    if (g.length === 0) {
      out.push({ workerId: p.w.id, name: p.w.name, areas: [], fixedCount: blocks[i].length, driveMinutes: 0, stops: [] });
      continue;
    }
    const pts = [p.home, ...g.map((m) => m.pt)];
    const order = g.length >= 2 ? await bestOrder(pts, back) : [0];
    const seq = order && order.length === g.length ? order.map((k) => g[k]) : g;
    const legs = (await legSeconds([p.home, ...seq.map((m) => m.pt), ...(back ? [p.home] : [])])) ?? seq.map(() => 15 * 60);

    let t = p.open;
    let drive = 0;
    const stops: PlanStop[] = [];
    for (let k = 0; k < seq.length; k++) {
      const m = seq[k];
      drive += legs[k] ?? 0;
      // The travel allowance is the gap between visits; the map only sets the order. Visits with none recorded fall
      // back to the drive time.
      const gapBefore = Math.max(k > 0 ? seq[k - 1].travelMs : 0, m.travelMs);
      let start = roundUp5(t + (gapBefore > 0 ? gapBefore : (legs[k] ?? 0) * 1000));
      for (let moved = true; moved; ) {
        moved = false;
        for (const b of blocks[i]) {
          const gap = travelGapMs(b.a, m.travelMs / 60_000);
          if (start < b.e + gap && start + m.lengthMs + gap > b.s) {
            start = roundUp5(b.e + (gap > 0 ? gap : AFTER_FIXED_MS));
            moved = true;
          }
        }
      }
      const end = start + m.lengthMs;
      // The last visit of the day also needs the drive back to the start address.
      const tail = back && k === seq.length - 1 ? (legs[seq.length] ?? 0) * 1000 : 0;
      if (end + tail > p.close) {
        for (const rest of seq.slice(k)) unplaced.push({ visitId: rest.visit.id, title: rest.visit.jobTitle, reason: `${p.w.name}'s day is full once the driving is counted.` });
        break;
      }
      t = end;
      const wasWorker = m.visit.workerIds[0];
      const wasStart = toMs(m.visit.scheduledStart) ?? 0;
      const changed = wasWorker !== p.w.id || wasStart !== start;
      if (changed) changes++;
      stops.push({
        visitId: m.visit.id,
        title: m.visit.jobTitle,
        address: m.visit.address,
        startIso: new Date(start).toISOString(),
        endIso: new Date(end).toISOString(),
        startLabel: formatInZone(new Date(start), timezone, { hour: "numeric", minute: "2-digit" }),
        endLabel: formatInZone(new Date(end), timezone, { hour: "numeric", minute: "2-digit" }),
        wasWorkerName: wasWorker ? (nameOf.get(wasWorker) ?? "Someone") : "Nobody",
        wasLabel: formatInZone(new Date(wasStart), timezone, { hour: "numeric", minute: "2-digit" }),
        changed,
        driveMinutes: Math.round((legs[k] ?? 0) / 60),
      });
    }
    if (back && stops.length === seq.length) drive += legs[seq.length] ?? 0;
    const tally = new Map<string, number>();
    for (const m of g) if (m.city) tally.set(m.city, (tally.get(m.city) ?? 0) + 1);
    const areas = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
    out.push({ workerId: p.w.id, name: p.w.name, areas, fixedCount: blocks[i].length, driveMinutes: Math.round(drive / 60), stops });
  }
  return { day, people: out, unplaced, changes };
}

/** Moves the flexible visits to the people and times in the plan. Staff and customers get the usual moved messages. */
export async function applyDayPlan(
  subAccountId: string,
  day: string,
  expected: { visitId: string; workerId: string }[],
): Promise<{ moved: number }> {
  const plan = await planDay(subAccountId, day);
  const now = new Map(plan.people.flatMap((p) => p.stops.map((s) => [s.visitId, p.workerId] as const)));
  if (expected.length !== now.size || expected.some((e) => now.get(e.visitId) !== e.workerId)) {
    throw new FieldServicesError("The day changed since the plan was made. Plan it again.", 409);
  }
  const todo = plan.people.flatMap((p) => p.stops.filter((s) => s.changed).map((s) => ({ ...s, workerId: p.workerId })));
  if (todo.length === 0) throw new FieldServicesError("There is nothing to change.", 409);
  let moved = 0;
  for (const s of todo) {
    try {
      await updateVisit({
        subAccountId,
        visitId: s.visitId,
        body: { workerIds: [s.workerId], scheduledStart: s.startIso, scheduledEnd: s.endIso },
        keepAutoScheduled: true,
      });
    } catch (err) {
      const why = err instanceof FieldServicesError ? err.message : "an unexpected error";
      throw new FieldServicesError(`Stopped after changing ${moved} of ${todo.length} visits: ${why} Check the Schedule before trying again.`, 409);
    }
    moved++;
  }
  return { moved };
}
