import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatServiceAddress } from "@/lib/field-services/address";
import type { GeoPoint } from "@/lib/field-services/geo";
import { isDayKey } from "@/lib/field-services/intervals";
import { startPointOn } from "@/lib/field-services/start-point";
import { addDaysToKey, formatInZone, zonedTimeToUtc } from "@/lib/field-services/time";
import { cleanTravelMinutes, travelGapMs } from "@/lib/field-services/travel";
import { workerHoursOn } from "@/lib/field-services/working-hours";
import { workspaceTimezone } from "@/lib/server/field-first-slot";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { cachedGeocode, detourMinutes, serviceTravelMinutes, travelMinutes, type FitStop } from "@/lib/server/field-slot-fit";
import { geocodingConfigured } from "@/lib/server/geocode";
import { matchAreasForAddress } from "@/lib/server/service-area-match";
import type { FieldWorker, Job, ServiceArea, Visit } from "@/types/field-services";

const STEP_MIN = 30;
const MAX_GEOCODES = 80;
const PER_DAY_LIMIT = 48;
const FINAL = ["completed", "cancelled", "no_show"];
const WINDOWS: Record<string, [number, number]> = {
  morning: [6 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 21 * 60],
};

export interface FoundTime {
  startIso: string;
  endIso: string;
  day: string;
  label: string;
  time: string;
  workerIds: string[];
  workerName: string;
  /** Estimated minutes of driving to get there from the previous stop or the start of the day. Null when not known. */
  driveMinutes: number | null;
  tag?: "best" | "earliest";
}

export interface FindTimesResult {
  timezone: string;
  days: string[];
  suggestions: FoundTime[];
  byDay: Record<string, FoundTime[]>;
  note: string | null;
}

interface Booked {
  id: string;
  s: number;
  e: number;
  a: number;
  final: boolean;
  address: string;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const toMs = (v: unknown): number | null => {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
};

/**
 * Open times for a visit over up to 14 days: eligible staff (or the chosen people, all free together), inside hours,
 * clear of time off, other visits (by the travel allowance) and the daily limit. With maps set up, the best match adds the least driving.
 */
export async function findTimes(
  subAccountId: string,
  input: {
    jobId?: string;
    workerIds?: string[];
    minutes?: number;
    from: string;
    days?: number;
    window?: string;
    ignoreVisitId?: string;
  },
): Promise<FindTimesResult> {
  if (!isDayKey(input.from)) throw new FieldServicesError("Choose a start date.");
  const spanDays = Math.min(14, Math.max(1, Math.round(input.days ?? 7)));
  const db = getAdminDb();

  let job: Job | null = null;
  if (input.jobId) {
    const snap = await db.doc(`jobs/${input.jobId}`).get();
    const data = snap.data() as Job | undefined;
    if (!snap.exists || !data || data.subAccountId !== subAccountId) throw new FieldServicesError("Job not found.", 404);
    job = { ...data, id: snap.id };
  }
  const timezone = job?.timezone || (await workspaceTimezone(subAccountId));
  const productIds = job
    ? [...new Set(job.lineItems.filter((l) => !l.approvalId && l.productId).map((l) => l.productId as string))].slice(0, 20)
    : [];
  const travel = Math.max(0, ...(await Promise.all(productIds.map((id) => serviceTravelMinutes(id)))));
  const minutes = Math.min(Math.max(Math.round(input.minutes ?? 60) || 60, 15), 24 * 60);
  const lengthMs = minutes * 60_000;

  const workerSnap = await db.collection("fieldWorkers").where("subAccountId", "==", subAccountId).where("status", "==", "active").get();
  const everyone = workerSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as FieldWorker);
  const wanted = [...new Set((input.workerIds ?? []).filter((x) => typeof x === "string"))]
    .slice(0, 10)
    .filter((id) => everyone.some((w) => w.id === id));
  let workers: FieldWorker[];
  if (wanted.length > 0) {
    workers = wanted.map((id) => everyone.find((w) => w.id === id)).filter((w): w is FieldWorker => !!w);
    if (workers.length !== wanted.length) throw new FieldServicesError("One of the chosen staff isn't available.");
  } else {
    let areaId: string | null = null;
    if (job?.serviceAddress) {
      const areaSnap = await db.collection(`subAccounts/${subAccountId}/serviceAreas`).get();
      const areas = areaSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as ServiceArea);
      const match = areas.length > 0 ? await matchAreasForAddress(areas, job.serviceAddress) : { status: "unknown" as const };
      areaId = match.status === "in_area" ? match.area.id : null;
    }
    workers = everyone.filter((w) => {
      const services = w.serviceIds ?? [];
      // Everyone on the job must be able to do every service on it.
      if (services.length > 0 && productIds.length > 0 && !productIds.every((id) => services.includes(id))) return false;
      const mine = w.areaIds ?? [];
      return mine.length === 0 || (!!areaId && mine.includes(areaId));
    });
  }
  const together = wanted.length > 1;
  const dayBounds = (day: string): [number, number] => [
    zonedTimeToUtc(`${day}T00:00`, timezone).getTime(),
    zonedTimeToUtc(`${addDaysToKey(day, 1)}T00:00`, timezone).getTime(),
  ];
  const days = Array.from({ length: spanDays }, (_, i) => addDaysToKey(input.from, i));
  const empty: FindTimesResult = { timezone, days, suggestions: [], byDay: {}, note: null };
  if (workers.length === 0) return { ...empty, note: "No one is set up for this service in this area." };

  const rangeStart = zonedTimeToUtc(`${days[0]}T00:00`, timezone).getTime();
  const rangeEnd = zonedTimeToUtc(`${addDaysToKey(days[days.length - 1], 1)}T00:00`, timezone).getTime();
  const booked = new Map<string, Booked[]>();
  await Promise.all(
    workers.map(async (w) => {
      const snap = await db
        .collection("visits")
        .where("subAccountId", "==", subAccountId)
        .where("workerIds", "array-contains", w.id)
        .where("scheduledStart", ">=", Timestamp.fromMillis(rangeStart - 24 * 3_600_000))
        .where("scheduledStart", "<", Timestamp.fromMillis(rangeEnd + 6 * 3_600_000))
        .get();
      const list: Booked[] = [];
      for (const d of snap.docs) {
        if (d.id === input.ignoreVisitId) continue;
        const v = d.data() as Visit;
        if (v.status === "cancelled" || v.status === "no_show") continue;
        const s = toMs(v.scheduledStart);
        const e = toMs(v.scheduledEnd);
        if (s === null || e === null) continue;
        list.push({ id: d.id, s, e, a: cleanTravelMinutes(v.travelMinutes), final: FINAL.includes(v.status), address: v.address ?? "" });
      }
      booked.set(w.id, list);
    }),
  );

  // Times held for a customer who is paying a deposit are busy until the hold ends.
  const claimRefs = workers.flatMap((w) => days.map((d) => ({ w, ref: db.doc(`fieldSlotClaims/${subAccountId}_${w.id}_${d}`) })));
  const claimSnaps = claimRefs.length > 0 ? await db.getAll(...claimRefs.map((c) => c.ref)) : [];
  claimSnaps.forEach((snap, i) => {
    const holds = (snap.data()?.holds ?? {}) as Record<string, { s: number; e: number; x: number; a?: number }>;
    for (const h of Object.values(holds)) {
      if (h.x > Date.now()) {
        booked.get(claimRefs[i].w.id)?.push({ id: "hold", s: h.s, e: h.e, a: cleanTravelMinutes(h.a ?? travel), final: false, address: "" });
      }
    }
  });

  const [lo, hi] = WINDOWS[input.window ?? ""] ?? [0, 24 * 60];
  const earliestMs = Date.now() + STEP_MIN * 60_000;
  // One candidate per person per start time.
  const found = new Map<string, { startMs: number; day: string; who: FieldWorker[] }>();
  for (const day of days) {
    const dayStart = zonedTimeToUtc(`${day}T00:00`, timezone).getTime();
    const dayEnd = zonedTimeToUtc(`${addDaysToKey(day, 1)}T00:00`, timezone).getTime();
    for (const w of workers) {
      const hours = workerHoursOn(w, day);
      if (!hours) continue;
      const mine = booked.get(w.id) ?? [];
      if (w.maxVisitsPerDay && mine.filter((b) => b.s >= dayStart && b.s < dayEnd).length >= w.maxVisitsPerDay) continue;
      const close = hours.endMin >= 24 * 60 ? dayEnd : zonedTimeToUtc(`${day}T${hhmm(hours.endMin)}`, timezone).getTime();
      // The first job of the day needs the drive from where the day starts.
      const first = Math.ceil(Math.max(hours.startMin + travel, lo) / STEP_MIN) * STEP_MIN;
      for (let m = first; m < Math.min(hours.endMin, hi, 24 * 60); m += STEP_MIN) {
        const startMs = zonedTimeToUtc(`${day}T${hhmm(m)}`, timezone).getTime();
        const endMs = startMs + lengthMs;
        if (startMs < earliestMs || endMs > close) continue;
        const clash = mine.some((b) => {
          if (b.final) return false;
          const gap = travelGapMs(b.a, travel);
          return b.s < endMs + gap && b.e + gap > startMs;
        });
        if (clash) continue;
        const key = together ? `${startMs}` : `${startMs}|${w.id}`;
        const entry = found.get(key) ?? { startMs, day, who: [] };
        entry.who.push(w);
        found.set(key, entry);
      }
    }
  }
  const options = [...found.values()].filter((o) => (together ? o.who.length === workers.length : true));
  if (options.length === 0) return { ...empty, note: "No open times in these days. Try later dates or another part of the day." };

  // Drive time and detour need the places of the visits around each option.
  let customer: GeoPoint | null = null;
  const points = new Map<string, GeoPoint | null>();
  let driveNote: string | null = null;
  if (job?.serviceAddress && geocodingConfigured()) {
    try {
      const addresses = new Set<string>();
      for (const o of options) {
        const [dStart, dEnd] = dayBounds(o.day);
        for (const b of booked.get(o.who[0].id) ?? []) if (b.address && b.s >= dStart && b.s < dEnd) addresses.add(b.address);
      }
      if (addresses.size <= MAX_GEOCODES) {
        customer = await cachedGeocode(formatServiceAddress(job.serviceAddress), job.serviceAddress.country);
        await Promise.all(
          [...addresses].map(async (a) => {
            points.set(a, await cachedGeocode(a, job?.serviceAddress?.country));
          }),
        );
      } else {
        driveNote = "Drive times are left out because so many visits are booked in these days.";
      }
    } catch {
      customer = null;
    }
  }

  const scored = options.map((o) => {
    const lead = o.who[0];
    const endMs = o.startMs + lengthMs;
    let detour: number | null = null;
    let drive: number | null = null;
    if (customer) {
      const [dStart, dEnd] = dayBounds(o.day);
      const todays = (booked.get(lead.id) ?? []).filter((b) => b.s >= dStart && b.s < dEnd);
      const stops: FitStop[] = todays.map((b) => ({ start: b.s, end: b.e, pt: points.get(b.address) ?? null }));
      const home = startPointOn(lead, o.day);
      detour = detourMinutes(stops, home, customer, o.startMs, endMs);
      let prev: Booked | null = null;
      for (const b of todays) if (b.e <= o.startMs && (!prev || b.e > prev.e)) prev = b;
      const from = (prev ? points.get(prev.address) : null) ?? home;
      drive = from ? Math.round(travelMinutes(from, customer)) : null;
    }
    const at = new Date(o.startMs);
    const item: FoundTime = {
      startIso: at.toISOString(),
      endIso: new Date(endMs).toISOString(),
      day: o.day,
      label: formatInZone(at, timezone, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }),
      time: formatInZone(at, timezone, { hour: "numeric", minute: "2-digit" }),
      workerIds: o.who.map((w) => w.id),
      workerName: o.who.map((w) => w.name).join(" + "),
      driveMinutes: drive,
    };
    return { item, detour, startMs: o.startMs };
  });

  const byStart = [...scored].sort((a, b) => a.startMs - b.startMs || a.item.workerName.localeCompare(b.item.workerName));
  // The all-times list shows one entry per start time, for the person it fits best, so it never runs past the daily cap.
  const bestAt = new Map<number, (typeof scored)[number]>();
  for (const s of [...scored].sort((a, b) => (a.detour ?? 1e9) - (b.detour ?? 1e9) || a.item.workerName.localeCompare(b.item.workerName))) {
    if (!bestAt.has(s.startMs)) bestAt.set(s.startMs, s);
  }
  const listed = [...bestAt.values()].sort((a, b) => a.startMs - b.startMs);
  const byFit = scored.filter((s) => s.detour !== null).sort((a, b) => (a.detour as number) - (b.detour as number) || a.startMs - b.startMs);
  const picks: FoundTime[] = [];
  const take = (s: { item: FoundTime }, tag?: FoundTime["tag"]) => {
    if (picks.some((p) => p.startIso === s.item.startIso && p.workerName === s.item.workerName)) return;
    picks.push(tag ? { ...s.item, tag } : s.item);
  };
  if (byFit[0]) take(byFit[0], "best");
  take(byStart[0], "earliest");
  // Two more good fits on days not already suggested.
  for (const s of byFit) {
    if (picks.length >= 4) break;
    if (picks.some((p) => p.day === s.item.day)) continue;
    take(s);
  }

  const byDay: Record<string, FoundTime[]> = {};
  for (const s of listed) {
    const list = (byDay[s.item.day] ??= []);
    if (list.length < PER_DAY_LIMIT) list.push(s.item);
  }
  return { timezone, days, suggestions: picks, byDay, note: driveNote };
}
