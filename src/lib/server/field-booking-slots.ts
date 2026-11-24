import "server-only";
import { startPointOn } from "@/lib/field-services/start-point";

import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDayKey } from "@/lib/field-services/intervals";
import { formatServiceAddress, sanitizeServiceAddress } from "@/lib/field-services/address";
import type { GeoPoint } from "@/lib/field-services/geo";
import { geocodingConfigured } from "@/lib/server/geocode";
import { cachedGeocode, detourMinutes, FIT_BASE_MIN, FIT_SLACK_MIN, serviceTravelMinutes, type FitStop } from "@/lib/server/field-slot-fit";
import { cleanTravelMinutes, travelGapMs } from "@/lib/field-services/travel";
import { addDaysToKey, formatInZone, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import { workerHoursOn } from "@/lib/field-services/working-hours";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { matchAreasForAddress } from "@/lib/server/service-area-match";
import {
  bookingOpen,
  cleanCountry,
  loadServices,
  loadSub,
  maxDaysAhead,
  withVariant,
  type PublicBookingService,
} from "@/lib/server/field-booking-service";
import { pickAddOns, withExtraMinutes } from "@/lib/server/field-booking-pricing";
import type { FieldWorker, ServiceAddress, ServiceArea, Visit } from "@/types/field-services";

const STEP_MIN = 30;
const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 8 * 60;
const CLAIM_MS = 2 * 60_000;
const FINAL = ["completed", "cancelled", "no_show"];

export interface BookingSlot {
  /** ISO start time. */
  start: string;
  /** Time of day in the business's zone, such as 2:30 pm. */
  time: string;
  /** Day and time, such as Tue 3 Nov, 2:30 pm. */
  label: string;
}

/** A booked stretch with the travel time its own service keeps free around it. */
type Span = [start: number, end: number, travelMinutes: number];

interface Day {
  tz: string;
  day: string;
  durationMs: number;
  /** The service's fewest hours of notice, in milliseconds. */
  noticeMs: number;
  workers: FieldWorker[];
  busy: Map<string, Span[]>;
  /** Travel time this service keeps free before and after a job. */
  travelMin: number;
  /** Visits and held times each person already has that day. */
  counts: Map<string, number>;
  /** Where the customer is and where each person's day already goes; null when slots aren't ranked by route. */
  fit: { customer: GeoPoint; stops: Map<string, FitStop[]> } | null;
  /** Each person's day ends back at their start address, so the last job leaves time for the drive. */
  returnToBase: boolean;
  /** How many people the service needs at once. */
  need: number;
}

function toMs(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

async function busyOf(
  subAccountId: string,
  workerId: string,
  fromMs: number,
  toMsExclusive: number,
  ignoreVisitId?: string,
): Promise<{ spans: Span[]; count: number; places: { start: number; end: number; address: string }[] }> {
  const snap = await getAdminDb()
    .collection("visits")
    .where("subAccountId", "==", subAccountId)
    .where("workerIds", "array-contains", workerId)
    .where("scheduledStart", ">=", Timestamp.fromMillis(fromMs - 24 * 3_600_000))
    .where("scheduledStart", "<", Timestamp.fromMillis(toMsExclusive))
    .get();
  const out: Span[] = [];
  const places: { start: number; end: number; address: string }[] = [];
  let count = 0;
  for (const d of snap.docs) {
    if (d.id === ignoreVisitId) continue;
    const v = d.data() as Visit;
    const s = toMs(v.scheduledStart);
    const e = toMs(v.scheduledEnd);
    // Finished work still counts towards the day's limit, cancelled work does not.
    if (s !== null && s >= fromMs && v.status !== "cancelled" && v.status !== "no_show") count++;
    if (s !== null && e !== null && s >= fromMs && v.status !== "cancelled" && v.status !== "no_show" && v.address) {
      places.push({ start: s, end: e, address: v.address });
    }
    if (FINAL.includes(v.status)) continue;
    if (s !== null && e !== null) out.push([s, e, cleanTravelMinutes(v.travelMinutes)]);
  }
  return { spans: out, count, places };
}

/** Everything needed to say who is free on one day for one service at one address. */
async function loadDay(subAccountId: string, service: PublicBookingService, address: ServiceAddress, day: string, ignoreVisitId?: string): Promise<Day> {
  const sub = await loadSub(subAccountId);
  if (!sub) throw new FieldServicesError("Online booking isn't available.", 404);
  const config = await getFieldServicesConfig(subAccountId);
  if (!bookingOpen(sub, config) || config.bookingInstant !== true) {
    throw new FieldServicesError("Online booking isn't available.", 404);
  }
  const tz = typeof sub.timezone === "string" && sub.timezone ? sub.timezone : "UTC";
  const today = zonedDateKey(new Date(), tz);
  // A day of slack either way, because the customer picked the day in their own time zone.
  if (!isDayKey(day) || day < addDaysToKey(today, -1) || day > addDaysToKey(today, maxDaysAhead(config) + 1)) {
    throw new FieldServicesError("Choose a date from today onwards.");
  }
  const travelMin = await serviceTravelMinutes(service.id);
  const minutes = Math.min(service.durationMinutes && service.durationMinutes > 0 ? service.durationMinutes : DEFAULT_MINUTES, MAX_MINUTES);

  const db = getAdminDb();
  const [workerSnap, areaSnap] = await Promise.all([
    db.collection("fieldWorkers").where("subAccountId", "==", subAccountId).get(),
    db.collection(`subAccounts/${subAccountId}/serviceAreas`).get(),
  ]);
  const areas = areaSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as ServiceArea);
  const match = areas.length > 0 ? await matchAreasForAddress(areas, address) : { status: "unknown" as const };
  const areaId = match.status === "in_area" ? match.area.id : null;
  const workers = workerSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as FieldWorker)
    .filter((w) => {
      if (w.status !== "active") return false;
      const services = w.serviceIds ?? [];
      if (services.length > 0 && !services.includes(service.id)) return false;
      const mine = w.areaIds ?? [];
      if (mine.length > 0 && (!areaId || !mine.includes(areaId))) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const dayStart = zonedTimeToUtc(`${day}T00:00`, tz).getTime();
  const dayEnd = zonedTimeToUtc(`${addDaysToKey(day, 1)}T00:00`, tz).getTime();
  const busy = new Map<string, Span[]>();
  const counts = new Map<string, number>();
  const placesOf = new Map<string, { start: number; end: number; address: string }[]>();
  await Promise.all(
    workers.map(async (w) => {
      const r = await busyOf(subAccountId, w.id, dayStart, dayEnd, ignoreVisitId);
      busy.set(w.id, r.spans);
      counts.set(w.id, r.count);
      placesOf.set(w.id, r.places);
    }),
  );
  // Times held for a customer who is paying a deposit count as busy until the hold ends.
  const holdDocs = await Promise.all(workers.map((w) => db.doc(`fieldSlotClaims/${subAccountId}_${w.id}_${day}`).get()));
  holdDocs.forEach((snap, i) => {
    const holds = (snap.data()?.holds ?? {}) as Record<string, { s: number; e: number; x: number; a?: number }>;
    for (const h of Object.values(holds)) {
      if (h.x > Date.now()) {
        busy.get(workers[i].id)?.push([h.s, h.e, cleanTravelMinutes(h.a ?? travelMin)]);
        counts.set(workers[i].id, (counts.get(workers[i].id) ?? 0) + 1);
      }
    }
  });
  let fit: Day["fit"] = null;
  if (config.routeAwareSlots === true && config.routeSuggestionsEnabled === true && geocodingConfigured()) {
    // Ranking is advisory: any failure here must leave booking working with every free time.
    try {
      const customer = await cachedGeocode(formatServiceAddress(address), address.country);
      if (customer) {
        const country = address.country;
        const stops = new Map<string, FitStop[]>();
        await Promise.all(
          workers.map(async (w) => {
            const list = placesOf.get(w.id) ?? [];
            const pts = await Promise.all(list.map((p) => cachedGeocode(p.address, country)));
            stops.set(w.id, list.map((p, i) => ({ start: p.start, end: p.end, pt: pts[i] })));
          }),
        );
        fit = { customer, stops };
      }
    } catch {
      fit = null;
    }
  }
  return { tz, day, durationMs: minutes * 60_000, noticeMs: service.minLeadHours * 3_600_000, workers, busy, counts, fit, travelMin, returnToBase: config.routeReturnToBase === true && config.routeSuggestionsEnabled === true, need: Math.max(1, service.staffRequired || 1) };
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function clashes(spans: Span[], travelMin: number, startMs: number, endMs: number): boolean {
  return spans.some(([s, e, a]) => {
    const gap = travelGapMs(a, travelMin);
    return s < endMs + gap && e + gap > startMs;
  });
}

function isFree(ctx: Day, w: FieldWorker, startMs: number, endMs: number): boolean {
  const hours = workerHoursOn(w, ctx.day);
  if (!hours) return false;
  const open = zonedTimeToUtc(`${ctx.day}T${hhmm(hours.startMin)}`, ctx.tz).getTime();
  const close = hours.endMin >= 24 * 60 ? zonedTimeToUtc(`${addDaysToKey(ctx.day, 1)}T00:00`, ctx.tz).getTime() : zonedTimeToUtc(`${ctx.day}T${hhmm(hours.endMin)}`, ctx.tz).getTime();
  // The first job of the day needs the drive from where the day starts.
  if (startMs < open + ctx.travelMin * 60_000 || endMs + (ctx.returnToBase ? ctx.travelMin * 60_000 : 0) > close) return false;
  if (w.maxVisitsPerDay && (ctx.counts.get(w.id) ?? 0) >= w.maxVisitsPerDay) return false;
  return !clashes(ctx.busy.get(w.id) ?? [], ctx.travelMin, startMs, endMs);
}

/** Extra driving this person would take on for a visit at that time, or null when they could not reach it in time. */
function detourOf(ctx: Day, w: FieldWorker, startMs: number, endMs: number): number {
  if (!ctx.fit) return 0;
  return detourMinutes(ctx.fit.stops.get(w.id) ?? [], startPointOn(w, ctx.day), ctx.fit.customer, startMs, endMs, ctx.returnToBase ? startPointOn(w, ctx.day) : null);
}

/**
 * Every start time that falls on a half hour inside someone's working hours. When route ranking is on, a time is
 * only offered if someone can reach it in time and the extra driving is close to the best the day offers.
 */
function startsFor(ctx: Day, nowMs: number): number[] {
  const found = new Map<number, number[]>();
  for (const w of ctx.workers) {
    const hours = workerHoursOn(w, ctx.day);
    if (!hours) continue;
    for (let m = Math.ceil(hours.startMin / STEP_MIN) * STEP_MIN; m < hours.endMin && m < 24 * 60; m += STEP_MIN) {
      const startMs = zonedTimeToUtc(`${ctx.day}T${hhmm(m)}`, ctx.tz).getTime();
      if (startMs < nowMs + ctx.noticeMs) continue;
      if (!isFree(ctx, w, startMs, startMs + ctx.durationMs)) continue;
      found.set(startMs, [...(found.get(startMs) ?? []), detourOf(ctx, w, startMs, startMs + ctx.durationMs)]);
    }
  }
  // A time is offered only when enough people are free together, ranked by the driving of the people it would use.
  const best = new Map<number, number>();
  for (const [t, ds] of found) {
    if (ds.length < ctx.need) continue;
    best.set(t, [...ds].sort((a, b) => a - b).slice(0, ctx.need).reduce((n, x) => n + x, 0));
  }
  const starts = [...best.keys()].sort((a, b) => a - b);
  if (!ctx.fit || starts.length === 0) return starts;
  const limit = Math.max(FIT_BASE_MIN * ctx.need, Math.min(...best.values()) + FIT_SLACK_MIN * ctx.need);
  return starts.filter((t) => (best.get(t) as number) <= limit);
}

function slotOf(ms: number, tz: string): BookingSlot {
  const at = new Date(ms);
  return {
    start: at.toISOString(),
    time: formatInZone(at, tz, { hour: "numeric", minute: "2-digit" }),
    label: formatInZone(at, tz, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }),
  };
}

async function serviceFor(subAccountId: string, serviceId: unknown): Promise<PublicBookingService> {
  const config = await getFieldServicesConfig(subAccountId);
  const id = typeof serviceId === "string" ? serviceId : "";
  const service = (await loadServices(subAccountId, config.bookingServiceIds ?? [], config)).find((s) => s.id === id);
  if (!service) throw new FieldServicesError("Choose a service from the list.");
  return service;
}

function addressOf(raw: Record<string, unknown>, fallbackCountry: string): ServiceAddress {
  const t = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const address = sanitizeServiceAddress({
    line1: t(raw.line1, 200),
    city: t(raw.city, 100),
    region: t(raw.region, 100),
    postcode: t(raw.postcode, 12),
    country: cleanCountry(raw.country, fallbackCountry),
  });
  if (!address || !address.postcode) throw new FieldServicesError("Enter the street address and postcode.");
  return address;
}

/** The open times on one day for one service, for the booking page. */
export async function listBookingSlots(
  subAccountId: string,
  body: Record<string, unknown>,
  ignoreVisitId?: string,
  /** A visit being moved passes its booked service so the times match what claimBookingSlot will check. */
  bookedService?: PublicBookingService,
): Promise<{ slots: BookingSlot[]; timezone: string }> {
  const sub = await loadSub(subAccountId);
  if (!sub) throw new FieldServicesError("Online booking isn't available.", 404);
  let service = bookedService;
  if (!service) {
    const base = withVariant(await serviceFor(subAccountId, body.serviceId), body.variantId);
    const addOns = await pickAddOns(subAccountId, [base.id], body.addOnIds);
    service = withExtraMinutes(base, Math.min(480, addOns.reduce((sum, a) => sum + a.extraMinutes, 0)));
  }
  const address = addressOf(body, (sub.defaultPhoneCountry as string | undefined) || "US");
  const ctx = await loadDay(subAccountId, service, address, String(body.date ?? ""), ignoreVisitId);
  return { slots: startsFor(ctx, Date.now()).slice(0, 48).map((ms) => slotOf(ms, ctx.tz)), timezone: ctx.tz };
}

export interface ClaimedSlot {
  /** The first person held. */
  workerId: string;
  /** Everyone held, as many as the service needs. */
  workerIds: string[];
  /** The other people's holds beyond the first. */
  extra: { docPath: string; token: string }[];
  start: Date;
  end: Date;
  label: string;
  /** Where the hold is kept, so a deposit can find it later. */
  docPath: string;
  token: string;
  /** Keeps the hold until this time. */
  extend: (untilMs: number) => Promise<void>;
  /** Gives the hold back once the visit exists (or could not be made). */
  release: () => Promise<void>;
}

/**
 * Picks the least busy person who is free at the chosen time and holds that time for them, so two customers
 * cannot take the same slot. Throws if the time has gone.
 */
export async function claimBookingSlot(
  subAccountId: string,
  service: PublicBookingService,
  address: ServiceAddress,
  slot: unknown,
  /** A visit being moved: its own time does not count as busy, and its people are tried first. */
  moving?: { visitId: string; workerIds: string[] },
): Promise<ClaimedSlot> {
  const startMs = typeof slot === "string" ? new Date(slot).getTime() : NaN;
  const gone = new FieldServicesError("That time was just taken. Please choose another.", 409);
  if (!Number.isFinite(startMs)) throw new FieldServicesError("Choose a time.");
  const sub = await loadSub(subAccountId);
  if (!sub) throw new FieldServicesError("Online booking isn't available.", 404);
  const tz = typeof sub.timezone === "string" && sub.timezone ? sub.timezone : "UTC";
  const ctx = await loadDay(subAccountId, service, address, zonedDateKey(new Date(startMs), tz), moving?.visitId);
  if (!startsFor(ctx, Date.now()).includes(startMs)) throw gone;
  const endMs = startMs + ctx.durationMs;

  const dayStart = zonedTimeToUtc(`${ctx.day}T00:00`, ctx.tz).getTime();
  const dayEnd = zonedTimeToUtc(`${addDaysToKey(ctx.day, 1)}T00:00`, ctx.tz).getTime();
  const load = (w: FieldWorker) => (ctx.busy.get(w.id) ?? []).filter(([s]) => s >= dayStart && s < dayEnd).length;
  const detour = new Map(ctx.workers.map((w) => [w.id, detourOf(ctx, w, startMs, endMs)]));
  const candidates = ctx.workers
    .filter((w) => isFree(ctx, w, startMs, endMs))
    .sort((a, b) => Number(moving?.workerIds.includes(b.id) ?? false) - Number(moving?.workerIds.includes(a.id) ?? false) || (detour.get(a.id) ?? 0) - (detour.get(b.id) ?? 0) || load(a) - load(b) || a.name.localeCompare(b.name));

  const db = getAdminDb();
  const claimed: { w: FieldWorker; ref: FirebaseFirestore.DocumentReference; token: string; release: () => Promise<void> }[] = [];
  const releaseAll = async () => {
    await Promise.all(claimed.map((c) => c.release()));
  };
  try {
    for (const w of candidates) {
    if (claimed.length >= ctx.need) break;
    // One hold document per person per day, taken in a transaction, so overlapping bookings cannot both pass.
    const ref = db.doc(`fieldSlotClaims/${subAccountId}_${w.id}_${ctx.day}`);
    const token = `h${randomBytes(8).toString("hex")}`;
    const release = async () => {
      await ref.update({ [`holds.${token}`]: FieldValue.delete() }).catch(() => {});
    };
    const heldCount = await db.runTransaction(async (tx) => {
      const held = ((await tx.get(ref)).data()?.holds ?? {}) as Record<string, { s: number; e: number; x: number; a?: number }>;
      const live = Object.fromEntries(Object.entries(held).filter(([, h]) => h.x > Date.now()));
      if (Object.values(live).some((h) => {
        const gap = travelGapMs(h.a, ctx.travelMin);
        return h.s < endMs + gap && h.e + gap > startMs;
      })) return 0;
      tx.set(ref, { holds: { ...live, [token]: { s: startMs, e: endMs, x: Date.now() + CLAIM_MS, a: ctx.travelMin } } });
      return Object.keys(live).length + 1;
    });
    if (heldCount === 0) continue;
    claimed.push({ w, ref, token, release });
    // Look again now the hold is ours: a visit may have been added since the first look.
    const fresh = await busyOf(subAccountId, w.id, dayStart, dayEnd, moving?.visitId);
    const others = fresh.count + (heldCount - 1);
    if (clashes(fresh.spans, ctx.travelMin, startMs, endMs) || (w.maxVisitsPerDay && others >= w.maxVisitsPerDay)) {
      await release();
      claimed.pop();
      continue;
    }
    }
  } catch (err) {
    // Nobody stays held when a look-up fails part way.
    await releaseAll();
    throw err;
  }
  // Everyone the service needs must be held, or none of them are.
  if (claimed.length < ctx.need) {
    await releaseAll();
    throw gone;
  }
  return {
    workerId: claimed[0].w.id,
    workerIds: claimed.map((c) => c.w.id),
    extra: claimed.slice(1).map((c) => ({ docPath: c.ref.path, token: c.token })),
    start: new Date(startMs),
    end: new Date(endMs),
    label: slotOf(startMs, ctx.tz).label,
    docPath: claimed[0].ref.path,
    token: claimed[0].token,
    extend: async (untilMs: number) => {
      await Promise.all(claimed.map((c) => c.ref.update({ [`holds.${c.token}.x`]: untilMs })));
    },
    release: releaseAll,
  };
}
