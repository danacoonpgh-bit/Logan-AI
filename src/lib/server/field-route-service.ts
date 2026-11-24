import "server-only";
import { startPointOn } from "@/lib/field-services/start-point";
import { cleanTravelMinutes } from "@/lib/field-services/travel";

import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { isDayKey } from "@/lib/field-services/intervals";
import { addDaysToKey, formatInZone, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import { portalToday } from "@/lib/server/field-portal-access";
import { workerHoursOn } from "@/lib/field-services/working-hours";
import { formatServiceAddress } from "@/lib/field-services/address";
import { geocode, geocodingConfigured } from "@/lib/server/geocode";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { updateVisit } from "@/lib/server/field-visits-service";
import { workspaceTimezone } from "@/lib/server/field-first-slot";
import type { FieldWorker, Job, Visit } from "@/types/field-services";

const MAX_STOPS = 11;
const FINAL = ["completed", "cancelled", "no_show"];

export interface RouteCheck {
  id: string;
  label: string;
  ok: boolean;
  fix: string;
}

export interface RouteReadiness {
  ok: boolean;
  checks: RouteCheck[];
}

/** What a workspace needs before route suggestions can be switched on. */
export async function routeReadiness(subAccountId: string): Promise<RouteReadiness> {
  const db = getAdminDb();
  const [serviceSnap, workerSnap] = await Promise.all([
    db.collection("products").where("subAccountId", "==", subAccountId).where("kind", "==", "service").get(),
    db.collection("fieldWorkers").where("subAccountId", "==", subAccountId).where("status", "==", "active").get(),
  ]);
  const services = serviceSnap.docs.filter((d) => d.data().active !== false).map((d) => ({ id: d.id, ...d.data() }) as { id: string; durationMinutes?: number });
  const workers = workerSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as FieldWorker);

  const noTime = services.filter((s) => !(typeof s.durationMinutes === "number" && s.durationMinutes > 0));
  const noBase = workers.filter((w) => !w.homeBasePoint);
  const restricted = workers.filter((w) => {
    const mine = w.serviceIds ?? [];
    return mine.length > 0 && services.some((s) => !mine.includes(s.id));
  });

  const checks: RouteCheck[] = [
    {
      id: "mapbox",
      label: "Map lookups are set up",
      ok: geocodingConfigured(),
      fix: "Ask whoever runs your deployment to set the Mapbox token.",
    },
    {
      id: "services",
      label: "One to three active services",
      ok: services.length >= 1 && services.length <= 3,
      fix: `You have ${services.length} active services. Route suggestions are for workspaces that offer a few uniform services.`,
    },
    {
      id: "durations",
      label: "Every service has a time allowance",
      ok: services.length > 0 && noTime.length === 0,
      fix: noTime.length > 0 ? `Set the length for ${noTime.map((s) => (s as { name?: string }).name ?? "a service").join(", ")}.` : "Add a service with a length.",
    },
    {
      id: "everyone",
      label: "All staff do all services",
      ok: restricted.length === 0,
      fix: `${restricted.map((w) => w.name).join(", ")} ${restricted.length === 1 ? "is" : "are"} limited to some services. Clear that in their details.`,
    },
    {
      id: "base",
      label: "Every staff member has a start address",
      ok: workers.length > 0 && noBase.length === 0,
      fix: workers.length === 0 ? "Add staff first." : `Add or correct the start address for ${noBase.map((w) => w.name).join(", ")}.`,
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

export interface RouteStop {
  visitId: string;
  title: string;
  address: string;
  startMs: number;
  endMs: number;
  /** Driving time to get here from the previous stop (the start address for the first). */
  driveMinutes: number;
  startLabel: string;
  endLabel: string;
  /** When this visit was booked for before the change. */
  wasLabel: string;
}

export interface RouteSuggestion {
  workerId: string;
  workerName: string;
  day: string;
  timezone: string;
  /** The current order's total driving, in minutes. */
  currentDriveMinutes: number;
  suggestedDriveMinutes: number;
  savedMinutes: number;
  /** False when the current order is already as good (or the better order does not fit the working day). */
  better: boolean;
  message: string;
  /** Driving from the last visit back to the start address; null when return to base is off. */
  returnMinutes: number | null;
  stops: RouteStop[];
}

function token(): string {
  return (process.env.MAPBOX_GEOCODING_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "").trim();
}

function toMs(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

export type Pt = { lng: number; lat: number };

const coords = (pts: Pt[]) => pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");

async function mapboxJson<T>(url: URL): Promise<T | null> {
  url.searchParams.set("access_token", token());
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Driving seconds between consecutive points, in the order given. */
export async function legSeconds(pts: Pt[]): Promise<number[] | null> {
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${coords(pts)}`);
  url.searchParams.set("overview", "false");
  const data = await mapboxJson<{ routes?: { legs?: { duration: number }[] }[] }>(url);
  const legs = data?.routes?.[0]?.legs;
  return legs && legs.length === pts.length - 1 ? legs.map((l) => l.duration) : null;
}

/**
 * The best order for the stops after the start point, from Mapbox's trip optimiser. Indexes into the stops. With
 * endAtStart the day finishes back at the start point, which is sent as a fixed last waypoint.
 */
export async function bestOrder(pts: Pt[], endAtStart = false): Promise<number[] | null> {
  const sent = endAtStart ? [...pts, pts[0]] : pts;
  const url = new URL(`https://api.mapbox.com/optimized-trips/v1/mapbox/driving/${coords(sent)}`);
  url.searchParams.set("source", "first");
  url.searchParams.set("destination", endAtStart ? "last" : "any");
  url.searchParams.set("roundtrip", "false");
  url.searchParams.set("overview", "false");
  const data = await mapboxJson<{ code?: string; trips?: unknown[]; waypoints?: { waypoint_index: number }[] }>(url);
  if (!data || data.code !== "Ok" || data.trips?.length !== 1 || !data.waypoints || data.waypoints.length !== sent.length) return null;
  // waypoints[i] says where input i sits in the trip; invert it to get the trip order.
  const order = new Array<number>(sent.length);
  data.waypoints.forEach((w, input) => {
    order[w.waypoint_index] = input;
  });
  if (order.some((i) => typeof i !== "number")) return null;
  const inner = endAtStart ? order.slice(1, -1) : order.slice(1);
  return inner.map((i) => i - 1);
}

export function roundUp5(ms: number): number {
  const step = 5 * 60_000;
  return Math.ceil(ms / step) * step;
}

/** First day the system may change: today plus the lead days, in the workspace time zone. */
export function earliestRouteDay(leadDays: number | undefined, timezone: string): string {
  const n = typeof leadDays === "number" && leadDays >= 1 && leadDays <= 14 ? Math.floor(leadDays) : 1;
  return addDaysToKey(zonedDateKey(new Date(), timezone), n);
}

/** The last day route changes are offered: today plus the chosen reach (7, 14, 21 or 28 days). */
export function latestRouteDay(maxDays: number | undefined, timezone: string): string {
  const n = maxDays === 14 || maxDays === 21 || maxDays === 28 ? maxDays : 7;
  return addDaysToKey(zonedDateKey(new Date(), timezone), n);
}

export async function routeGate(subAccountId: string, day?: string): Promise<void> {
  const config = await getFieldServicesConfig(subAccountId);
  if (config.routeSuggestionsEnabled !== true) {
    throw new FieldServicesError("Route suggestions are switched off in Settings.", 409);
  }
  if (day) {
    const timezone = await workspaceTimezone(subAccountId);
    const latest = latestRouteDay(config.routeMaxDays, timezone);
    if (day > latest) {
      throw new FieldServicesError(
        `Route changes only open up to ${config.routeMaxDays ?? 7} days ahead, until ${latest}. Change how far ahead in Settings, Route suggestions.`,
        409,
      );
    }
    const earliest = earliestRouteDay(config.routeLeadDays, timezone);
    if (day < earliest) {
      throw new FieldServicesError(
        `Days inside the ${config.routeLeadDays}-day lead time are changed by hand. Route changes open from ${earliest}.`,
        409,
      );
    }
  }
  const failed = (await routeReadiness(subAccountId)).checks.find((c) => !c.ok);
  if (failed) {
    throw new FieldServicesError(`Route suggestions need the setup checks in Settings to pass: ${failed.label}. ${failed.fix}`, 409);
  }
}

/** Works out a shorter driving order for one person's day and the times each visit would then start. */
export async function suggestRoute(subAccountId: string, workerId: string, day: string): Promise<RouteSuggestion> {
  if (!isDayKey(day)) throw new FieldServicesError("Choose a day.");
  await routeGate(subAccountId, day);
  const back = (await getFieldServicesConfig(subAccountId)).routeReturnToBase === true;
  const db = getAdminDb();
  const wSnap = await db.doc(`fieldWorkers/${workerId}`).get();
  const worker = wSnap.exists ? ({ id: wSnap.id, ...wSnap.data() } as FieldWorker) : null;
  if (!worker || worker.subAccountId !== subAccountId || worker.status !== "active") {
    throw new FieldServicesError("That staff member isn't available.", 404);
  }
  const startPoint = startPointOn(worker, day);
  if (!startPoint) throw new FieldServicesError(`${worker.name} has no start address yet.`);

  const timezone = await workspaceTimezone(subAccountId);
  const dayStart = zonedTimeToUtc(`${day}T00:00`, timezone).getTime();
  const dayEnd = zonedTimeToUtc(`${addDaysToKey(day, 1)}T00:00`, timezone).getTime();
  const snap = await db
    .collection("visits")
    .where("subAccountId", "==", subAccountId)
    .where("workerIds", "array-contains", workerId)
    .where("scheduledStart", ">=", Timestamp.fromMillis(dayStart))
    .where("scheduledStart", "<", Timestamp.fromMillis(dayEnd))
    .get();
  const visits = snap.docs
    .map((d) => ({ ...(d.data() as Visit), id: d.id }))
    .filter((v) => v.status !== "cancelled" && v.status !== "no_show")
    .sort((a, b) => (toMs(a.scheduledStart) ?? 0) - (toMs(b.scheduledStart) ?? 0));

  if (visits.length < 2) throw new FieldServicesError("There is nothing to reorder: the day needs at least two visits.");
  // The map service takes 12 points; with return to base the start is sent twice.
  const maxStops = back ? MAX_STOPS - 1 : MAX_STOPS;
  if (visits.length > maxStops) throw new FieldServicesError(`Route suggestions handle up to ${maxStops} visits in a day.`);
  if (visits.some((v) => FINAL.includes(v.status) || v.status !== "pending")) {
    throw new FieldServicesError("A visit that day has already started or finished, so the day can't be reordered.");
  }
  if (visits.some((v) => v.anytime || v.arrivalWindow)) {
    throw new FieldServicesError("A visit that day is any-time or has an arrival window, so the day can't be reordered.");
  }
  if (visits.some((v) => v.workerIds.length > 1)) {
    throw new FieldServicesError("A visit that day is shared with other staff, so the day can't be reordered on its own.");
  }

  const jobSnaps = await db.getAll(...[...new Set(visits.map((v) => v.jobId))].map((id) => db.doc(`jobs/${id}`)));
  const jobAddress = new Map(jobSnaps.map((j) => [j.id, (j.data() as Job | undefined)?.serviceAddress ?? null]));
  const found = await Promise.all(
    visits.map((v) => {
      const a = jobAddress.get(v.jobId);
      return a ? geocode(formatServiceAddress(a), a.country) : geocode(v.address);
    }),
  );
  const missing = found.findIndex((p) => !p);
  if (missing >= 0) throw new FieldServicesError(`Couldn't find the address for ${visits[missing].jobTitle}.`);
  const base = startPoint;
  const pts: Pt[] = [base, ...found.map((p) => ({ lng: p!.lng, lat: p!.lat }))];

  // With return to base on, the day ends back at the start point, so the way home is part of every order.
  const home: Pt[] = back ? [base] : [];
  const [curLegs, order] = await Promise.all([legSeconds([...pts, ...home]), bestOrder(pts, back)]);
  if (!curLegs || !order) throw new FieldServicesError("The map service couldn't plan a route just now. Try again shortly.", 502);

  const newPts = [base, ...order.map((i) => pts[i + 1])];
  const newLegs = await legSeconds([...newPts, ...home]);
  if (!newLegs) throw new FieldServicesError("The map service couldn't plan a route just now. Try again shortly.", 502);

  const curTotal = curLegs.reduce((a, b) => a + b, 0);
  const newTotal = newLegs.reduce((a, b) => a + b, 0);

  // The day keeps its time slots, gaps included: each slot goes to the next visit in the new order, and a visit
  // starts later than its slot only when the drive from the one before needs it.
  const lengths = visits.map((v) => Math.max(15 * 60_000, (toMs(v.scheduledEnd) ?? 0) - (toMs(v.scheduledStart) ?? 0)));
  const slots = visits.map((v) => toMs(v.scheduledStart) ?? dayStart);
  const currentEnd = Math.max(...visits.map((v) => toMs(v.scheduledEnd) ?? 0));
  // The travel allowance of the two neighbouring visits is the gap; the drive time is only used when none is recorded.
  const travelMs = (vi: number) => cleanTravelMinutes(visits[vi].travelMinutes) * 60_000;
  const gapBefore = (k: number) => {
    const g = Math.max(travelMs(order[k - 1]), travelMs(order[k]));
    return g > 0 ? g : newLegs[k] * 1000;
  };
  let t = 0;
  const stops: RouteStop[] = order.map((vi, k) => {
    const start = k === 0 ? slots[0] : Math.max(slots[k], roundUp5(t + gapBefore(k)));
    const end = start + lengths[vi];
    t = end;
    return {
      wasLabel: formatInZone(new Date(slots[vi]), timezone, { hour: "numeric", minute: "2-digit" }),
      visitId: visits[vi].id,
      title: visits[vi].jobTitle,
      address: visits[vi].address,
      startMs: start,
      endMs: end,
      driveMinutes: Math.round(newLegs[k] / 60),
      startLabel: formatInZone(new Date(start), timezone, { hour: "numeric", minute: "2-digit" }),
      endLabel: formatInZone(new Date(end), timezone, { hour: "numeric", minute: "2-digit" }),
    };
  });

  const hours = workerHoursOn(worker, day);
  if (!hours) throw new FieldServicesError(`${worker.name} isn't working that day.`);
  const closeMs =
    hours.endMin >= 24 * 60
      ? dayEnd
      : zonedTimeToUtc(`${day}T${String(Math.floor(hours.endMin / 60)).padStart(2, "0")}:${String(hours.endMin % 60).padStart(2, "0")}`, timezone).getTime();
  const sameOrder = order.every((vi, k) => vi === k);
  const saved = Math.round((curTotal - newTotal) / 60);
  // A day that already runs late is not made to look worse than it is.
  const backMs = back ? newLegs[order.length] * 1000 : 0;
  const curBackMs = back ? curLegs[visits.length] * 1000 : 0;
  const fits = stops[stops.length - 1].endMs + backMs <= Math.max(closeMs, currentEnd + curBackMs);

  const better = !sameOrder && saved >= 5 && fits;
  let message = `Saves about ${saved} minutes of driving.`;
  if (sameOrder || saved < 5) message = "This day is already in a good order.";
  else if (!fits) {
    message = `A shorter order exists, but it would run past the end of their working day${back ? ", counting the drive back" : ""}.`;
  }

  return {
    workerId,
    workerName: worker.name,
    day,
    timezone,
    currentDriveMinutes: Math.round(curTotal / 60),
    suggestedDriveMinutes: Math.round(newTotal / 60),
    savedMinutes: Math.max(0, saved),
    better,
    message,
    returnMinutes: back ? Math.round(newLegs[order.length] / 60) : null,
    stops,
  };
}

/** Re-times the day to the suggested order. The staff and customers get the usual moved messages. */
export async function applyRoute(
  subAccountId: string,
  workerId: string,
  day: string,
  expectedOrder: string[],
): Promise<{ moved: number; warnings: string[] }> {
  const s = await suggestRoute(subAccountId, workerId, day);
  if (!s.better) throw new FieldServicesError("There is no better order to apply.", 409);
  if (s.stops.map((x) => x.visitId).join(",") !== expectedOrder.join(",")) {
    throw new FieldServicesError("The day changed since the suggestion. Suggest the route again.", 409);
  }
  // Each update would warn about overlaps with visits that have not moved yet, so the warnings are left out: the new
  // times follow one another by construction and the person, service and area are unchanged.
  let moved = 0;
  for (const stop of s.stops) {
    try {
      await updateVisit({
        subAccountId,
        visitId: stop.visitId,
        body: { scheduledStart: new Date(stop.startMs).toISOString(), scheduledEnd: new Date(stop.endMs).toISOString() },
        keepAutoScheduled: true,
      });
    } catch (err) {
      const why = err instanceof FieldServicesError ? err.message : "an unexpected error";
      throw new FieldServicesError(`Stopped after re-timing ${moved} of ${s.stops.length} visits: ${why} Check the Schedule before trying again.`, 409);
    }
    moved++;
  }
  return { moved, warnings: [] as string[] };
}

export interface CrewRouteStop {
  visitId: string;
  jobNumber: string;
  title: string;
  address: string;
  startIso: string | null;
  endIso: string | null;
  anytime: boolean;
  timezone: string;
  status: string;
  lat: number | null;
  lng: number | null;
  /** Driving time from the stop before it; null for the first stop or when a point is missing. */
  driveMinutes: number | null;
}

export interface CrewRoute {
  day: string;
  configured: boolean;
  clock24: boolean;
  stops: CrewRouteStop[];
  /** The driving line through the located stops, as [lng, lat] points. */
  line: [number, number][];
  totalDriveMinutes: number | null;
}

const pointCache = new Map<string, { at: number; pt: Pt | null }>();
const dayCache = new Map<string, { at: number; value: CrewRoute }>();
const POINT_TTL = 24 * 3_600_000;
const DAY_TTL = 60_000;

async function pointFor(address: string): Promise<Pt | null> {
  const key = address.trim().toLowerCase();
  const hit = pointCache.get(key);
  if (hit && Date.now() - hit.at < POINT_TTL) return hit.pt;
  const p = await geocode(address);
  const pt = p ? { lng: p.lng, lat: p.lat } : null;
  if (pointCache.size > 500) pointCache.clear();
  pointCache.set(key, { at: Date.now(), pt });
  return pt;
}

/** One crew person's visits on one day, in time order, with map points and the driving between them. */
export async function crewRoute(personId: string, day: string): Promise<CrewRoute> {
  if (!isDayKey(day)) throw new FieldServicesError("Choose a day.");
  const cacheKey = `${personId}:${day}`;
  const cached = dayCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DAY_TTL) return cached.value;

  const all = await portalToday(personId);
  const visits = all
    .filter((v) => v.visit.status !== "cancelled" && v.visit.status !== "no_show" && v.visit.scheduledStart)
    .filter((v) => zonedDateKey(new Date(v.visit.scheduledStart as string), v.job.timezone) === day)
    .sort((a, b) => (a.visit.scheduledStart as string).localeCompare(b.visit.scheduledStart as string));

  const configured = geocodingConfigured();
  const points = configured ? await Promise.all(visits.map((v) => (v.job.address ? pointFor(v.job.address) : Promise.resolve(null)))) : visits.map(() => null);

  const stops: CrewRouteStop[] = visits.map((v, i) => ({
    visitId: v.visit.id,
    jobNumber: v.job.number,
    title: v.job.title,
    address: v.job.address,
    startIso: v.visit.scheduledStart,
    endIso: v.visit.scheduledEnd,
    anytime: v.visit.anytime,
    timezone: v.job.timezone,
    status: v.visit.status,
    lat: points[i]?.lat ?? null,
    lng: points[i]?.lng ?? null,
    driveMinutes: null,
  }));

  let line: [number, number][] = [];
  let total: number | null = null;
  const located = stops.filter((s) => s.lat !== null && s.lng !== null);
  if (configured && located.length >= 2 && located.length <= 25) {
    const pts = located.map((s) => ({ lng: s.lng as number, lat: s.lat as number }));
    const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${coords(pts)}`);
    url.searchParams.set("overview", "simplified");
    url.searchParams.set("geometries", "geojson");
    const data = await mapboxJson<{ routes?: { duration: number; geometry?: { coordinates?: [number, number][] }; legs?: { duration: number }[] }[] }>(url);
    const r = data?.routes?.[0];
    if (r?.legs && r.legs.length === located.length - 1) {
      located.slice(1).forEach((s, k) => {
        s.driveMinutes = Math.round(r.legs![k].duration / 60);
      });
      line = r.geometry?.coordinates ?? [];
      total = Math.round(r.duration / 60);
    }
  }

  const value: CrewRoute = { day, configured, clock24: all[0]?.clock24 === true, stops, line, totalDriveMinutes: total };
  if (dayCache.size > 200) dayCache.clear();
  dayCache.set(cacheKey, { at: Date.now(), value });
  return value;
}
