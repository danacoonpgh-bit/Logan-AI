import "server-only";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatServiceAddress } from "@/lib/field-services/address";
import { isDayKey } from "@/lib/field-services/intervals";
import { startPointOn } from "@/lib/field-services/start-point";
import { addDaysToKey, formatInZone, zonedTimeToUtc } from "@/lib/field-services/time";
import { cleanTravelMinutes, tooClose } from "@/lib/field-services/travel";
import { workerHoursOn } from "@/lib/field-services/working-hours";
import { workspaceTimezone } from "@/lib/server/field-first-slot";
import { legSeconds, routeGate, type Pt } from "@/lib/server/field-route-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { updateVisit } from "@/lib/server/field-visits-service";
import { geocode } from "@/lib/server/geocode";
import { matchAreasForAddress } from "@/lib/server/service-area-match";
import type { FieldWorker, Job, ServiceArea, Visit } from "@/types/field-services";

const MAX_STEPS = 200;
/** A swap has to save at least this much driving, so the plan never shuffles people for nothing. */
const MIN_GAIN_KM = 0.4;
/** Keeps one person from collecting everything: each visit above an even share costs this much. */
const SPREAD_KM = 0.5;

export interface BalanceMove {
  visitId: string;
  title: string;
  address: string;
  timeLabel: string;
  fromName: string;
  toName: string;
  toWorkerId: string;
}

export interface BalancePerson {
  workerId: string;
  name: string;
  visitsBefore: number;
  visitsAfter: number;
  driveMinutesBefore: number;
  driveMinutesAfter: number;
}

export interface DayBalance {
  day: string;
  moves: BalanceMove[];
  people: BalancePerson[];
  /** Visits left alone because they were set by hand, have a fixed arrival, or nobody else can take them. */
  keptCount: number;
  driveMinutesBefore: number;
  driveMinutesAfter: number;
}

const toMs = (v: unknown): number => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : 0;
};

function km(a: Pt, b: Pt): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

interface Item {
  v: Visit & { id: string };
  s: number;
  e: number;
  pt: Pt | null;
  travel: number;
}

/**
 * Keeps every visit's time and works out whether handing some to another person cuts the day's driving. Only visits
 * the system placed can move; ones assigned by hand, started or with a fixed arrival stay and count in that person's route.
 */
export async function balanceDay(subAccountId: string, day: string): Promise<DayBalance> {
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
    .map((w) => ({ w, hours: workerHoursOn(w, day), home: startPointOn(w, day) }))
    .filter((p): p is { w: FieldWorker; hours: { startMin: number; endMin: number }; home: Pt } => !!p.hours && !!p.home)
    .map((p) => ({
      w: p.w,
      home: p.home,
      open: zonedTimeToUtc(`${day}T${hhmm(p.hours.startMin)}`, timezone).getTime(),
      close: p.hours.endMin >= 24 * 60 ? dayEnd : zonedTimeToUtc(`${day}T${hhmm(p.hours.endMin)}`, timezone).getTime(),
    }))
    .filter((p) => p.close > p.open)
    .sort((a, b) => a.w.name.localeCompare(b.w.name));
  if (people.length < 2) throw new FieldServicesError("Balancing staff needs at least two people working that day with a start address.");
  const idxOf = new Map(people.map((p, i) => [p.w.id, i]));

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
    v.workerIds.length === 1 &&
    v.autoScheduled === true &&
    idxOf.has(v.workerIds[0]);
  if (visits.length === 0) throw new FieldServicesError("Nothing to balance: there are no visits that day.");
  const jobSnaps = await db.getAll(...[...new Set(visits.map((v) => v.jobId))].map((id) => db.doc(`jobs/${id}`)));
  const jobOf = new Map(
    jobSnaps.map((j) => {
      const job = j.data() as Job | undefined;
      return [j.id, job?.subAccountId === subAccountId ? job : undefined] as const;
    }),
  );
  const found = await Promise.all(
    visits.map((v) => {
      const a = jobOf.get(v.jobId)?.serviceAddress;
      return a ? geocode(formatServiceAddress(a), a.country) : geocode(v.address);
    }),
  );
  const items: Item[] = visits.map((v, i) => ({
    v,
    s: toMs(v.scheduledStart),
    e: toMs(v.scheduledEnd),
    pt: found[i] ? { lng: found[i]!.lng, lat: found[i]!.lat } : null,
    travel: cleanTravelMinutes(v.travelMinutes),
  }));
  const movable = items.filter((it) => flexible(it.v) && it.pt);
  const fixed = items.filter((it) => !movable.includes(it));
  if (movable.length === 0) throw new FieldServicesError("Nothing to balance: every visit that day was assigned by hand, has a fixed arrival, or its address couldn't be found.");

  // Who could take each movable visit, by what they are set up for and when they work.
  const areaSnap = await db.collection(`subAccounts/${subAccountId}/serviceAreas`).get();
  const areas = areaSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as ServiceArea);
  const fixedFor = people.map((p) => fixed.filter((it) => it.v.workerIds.includes(p.w.id)));
  const can: boolean[][] = [];
  for (const m of movable) {
    const job = jobOf.get(m.v.jobId);
    const serviceIds = (job?.lineItems ?? []).map((l) => l.productId).filter((id): id is string => !!id);
    let areaId: string | null = null;
    const a = job?.serviceAddress;
    if (a && areas.length > 0) {
      const hit = await matchAreasForAddress(areas, { line1: a.line1, city: a.city, region: a.region, postcode: a.postcode, country: a.country }).catch(() => null);
      if (hit && hit.status === "in_area") areaId = hit.area.id;
    }
    can.push(
      people.map((p, pi) => {
        if (m.s < p.open || m.e > p.close) return false;
        const mine = p.w.serviceIds ?? [];
        if (mine.length > 0 && serviceIds.some((id) => !mine.includes(id))) return false;
        const myAreas = p.w.areaIds ?? [];
        if (areaId && myAreas.length > 0 && !myAreas.includes(areaId)) return false;
        return !fixedFor[pi].some((f) => tooClose({ start: f.s, end: f.e, travelMinutes: f.travel }, m.s, m.e, m.travel));
      }),
    );
  }

  const original = movable.map((m) => idxOf.get(m.v.workerIds[0]) as number);
  const assign = [...original];

  const visitsOf = (p: number, a: number[]): Item[] =>
    [...fixedFor[p], ...movable.filter((_, i) => a[i] === p)].sort((x, y) => x.s - y.s);
  const pathKm = (p: number, list: Item[]): number => {
    let at = people[p].home;
    let total = 0;
    for (const it of list) {
      if (!it.pt) continue;
      total += km(at, it.pt);
      at = it.pt;
    }
    if (back && at !== people[p].home) total += km(at, people[p].home);
    return total;
  };
  const cost = (a: number[]): number => {
    const counts = people.map((_, p) => visitsOf(p, a).length);
    const mean = counts.reduce((n, c) => n + c, 0) / people.length;
    return people.reduce((n, _, p) => n + pathKm(p, visitsOf(p, a)), 0) + SPREAD_KM * counts.reduce((n, c) => n + (c - mean) ** 2, 0);
  };
  const feasible = (a: number[], i: number, p: number): boolean => {
    if (!can[i][p]) return false;
    const others = movable.filter((_, j) => j !== i && a[j] === p);
    if (others.some((o) => tooClose({ start: o.s, end: o.e, travelMinutes: o.travel }, movable[i].s, movable[i].e, movable[i].travel))) return false;
    const max = people[p].w.maxVisitsPerDay;
    return !(max && fixedFor[p].length + others.length + 1 > max);
  };

  let current = cost(assign);
  for (let step = 0; step < MAX_STEPS; step++) {
    let best: { a: number[]; cost: number } | null = null;
    for (let i = 0; i < movable.length; i++) {
      for (let p = 0; p < people.length; p++) {
        if (p === assign[i] || !feasible(assign, i, p)) continue;
        const next = [...assign];
        next[i] = p;
        const c = cost(next);
        if (c < current - MIN_GAIN_KM && (!best || c < best.cost)) best = { a: next, cost: c };
      }
      for (let j = i + 1; j < movable.length; j++) {
        if (assign[i] === assign[j]) continue;
        const next = [...assign];
        next[i] = assign[j];
        next[j] = assign[i];
        if (!feasible(next, i, next[i]) || !feasible(next, j, next[j])) continue;
        const c = cost(next);
        if (c < current - MIN_GAIN_KM && (!best || c < best.cost)) best = { a: next, cost: c };
      }
    }
    if (!best) break;
    assign.splice(0, assign.length, ...best.a);
    current = best.cost;
  }

  const moves: BalanceMove[] = [];
  movable.forEach((m, i) => {
    if (assign[i] === original[i]) return;
    moves.push({
      visitId: m.v.id,
      title: m.v.jobTitle,
      address: m.v.address,
      timeLabel: `${formatInZone(new Date(m.s), timezone, { hour: "numeric", minute: "2-digit" })} to ${formatInZone(new Date(m.e), timezone, { hour: "numeric", minute: "2-digit" })}`,
      fromName: nameOf.get(m.v.workerIds[0]) ?? "Someone",
      toName: people[assign[i]].w.name,
      toWorkerId: people[assign[i]].w.id,
    });
  });

  // Real driving time before and after, from the map.
  const minutes = async (p: number, a: number[]): Promise<number> => {
    const list = visitsOf(p, a).filter((it) => it.pt);
    if (list.length === 0) return 0;
    const pts = [people[p].home, ...list.map((it) => it.pt as Pt), ...(back ? [people[p].home] : [])];
    const legs = await legSeconds(pts);
    return Math.round((legs ? legs.reduce((n, s) => n + s, 0) : pathKm(p, list) * 120) / 60);
  };
  const out: BalancePerson[] = [];
  for (let p = 0; p < people.length; p++) {
    const same = moves.length === 0 || visitsOf(p, original).map((it) => it.v.id).join() === visitsOf(p, assign).map((it) => it.v.id).join();
    const before = await minutes(p, original);
    out.push({
      workerId: people[p].w.id,
      name: people[p].w.name,
      visitsBefore: visitsOf(p, original).length,
      visitsAfter: visitsOf(p, assign).length,
      driveMinutesBefore: before,
      driveMinutesAfter: same ? before : await minutes(p, assign),
    });
  }
  return {
    day,
    moves,
    people: out,
    keptCount: items.length - moves.length,
    driveMinutesBefore: out.reduce((n, p) => n + p.driveMinutesBefore, 0),
    driveMinutesAfter: out.reduce((n, p) => n + p.driveMinutesAfter, 0),
  };
}

/** Hands the visits in the plan to their new person. Times never change, so customers are not messaged; the staff are alerted. */
export async function applyBalance(
  subAccountId: string,
  day: string,
  expected: { visitId: string; workerId: string }[],
): Promise<{ moved: number }> {
  const plan = await balanceDay(subAccountId, day);
  const now = new Map(plan.moves.map((m) => [m.visitId, m.toWorkerId]));
  if (expected.length !== now.size || expected.some((e) => now.get(e.visitId) !== e.workerId)) {
    throw new FieldServicesError("The day changed since the plan was made. Balance it again.", 409);
  }
  if (plan.moves.length === 0) throw new FieldServicesError("There is nothing to change.", 409);
  let moved = 0;
  for (const m of plan.moves) {
    try {
      await updateVisit({ subAccountId, visitId: m.visitId, body: { workerIds: [m.toWorkerId] }, keepAutoScheduled: true });
    } catch (err) {
      const why = err instanceof FieldServicesError ? err.message : "an unexpected error";
      throw new FieldServicesError(`Stopped after changing ${moved} of ${plan.moves.length} visits: ${why} Check the Schedule before trying again.`, 409);
    }
    moved++;
  }
  return { moved };
}
