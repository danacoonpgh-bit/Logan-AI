import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { addDaysToKey, formatInZone, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import { matchAreasForAddress } from "@/lib/server/service-area-match";
import { workerHoursOn } from "@/lib/field-services/working-hours";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { cleanTravelMinutes, travelGapMs } from "@/lib/field-services/travel";
import { serviceTravelMinutes } from "@/lib/server/field-slot-fit";
import type { FieldWorker, ServiceAddress, ServiceArea, Visit } from "@/types/field-services";

const STEP_MIN = 30;
const LOOK_AHEAD_DAYS = 60;
const FINAL = ["completed", "cancelled", "no_show"];

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function toMs(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

/** The workspace's time zone, which is also the zone a new project's visits are placed in. */
export async function workspaceTimezone(subAccountId: string): Promise<string> {
  const tz = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data()?.timezone;
  return typeof tz === "string" && tz ? tz : "UTC";
}

/**
 * The earliest start, on a half hour, when every chosen person is working, free of other visits and under their
 * daily visit limit, for a visit of the given length. Null when nothing fits in the next 60 days.
 */
export async function suggestFirstSlot(
  subAccountId: string,
  workerIds: string[],
  minutes: number,
  travelMinutes = 0,
): Promise<{ start: string | null; timezone: string }> {
  const travel = cleanTravelMinutes(travelMinutes);
  const ids = [...new Set(workerIds)].slice(0, 10);
  const timezone = await workspaceTimezone(subAccountId);
  if (ids.length === 0) return { start: null, timezone };
  const length = Math.min(Math.max(Math.round(minutes) || 60, 15), 8 * 60);

  const db = getAdminDb();
  const snaps = await Promise.all(ids.map((id) => db.doc(`fieldWorkers/${id}`).get()));
  const workers = snaps.map((s) => {
    const d = s.data();
    if (!s.exists || d?.subAccountId !== subAccountId || d?.status !== "active") {
      throw new FieldServicesError("One of the chosen staff isn't available.");
    }
    return { id: s.id, ...d } as FieldWorker;
  });

  const now = Date.now();
  const today = zonedDateKey(new Date(now), timezone);
  const horizon = zonedTimeToUtc(`${addDaysToKey(today, LOOK_AHEAD_DAYS)}T00:00`, timezone).getTime();
  const visits = await Promise.all(
    workers.map(async (w) => {
      const snap = await db
        .collection("visits")
        .where("subAccountId", "==", subAccountId)
        .where("workerIds", "array-contains", w.id)
        .where("scheduledStart", ">=", Timestamp.fromMillis(now - 24 * 3_600_000))
        .where("scheduledStart", "<", Timestamp.fromMillis(horizon))
        .get();
      return snap.docs
        .map((d) => d.data() as Visit)
        .map((v) => ({ s: toMs(v.scheduledStart), e: toMs(v.scheduledEnd), status: v.status, a: cleanTravelMinutes(v.travelMinutes) }))
        .filter((v): v is { s: number; e: number; status: Visit["status"]; a: number } => v.s !== null && v.e !== null);
    }),
  );

  const earliest = now + STEP_MIN * 60_000;
  for (let i = 0; i < LOOK_AHEAD_DAYS; i++) {
    const day = addDaysToKey(today, i);
    const hours = workers.map((w) => workerHoursOn(w, day));
    if (hours.some((h) => !h)) continue;
    const open = Math.max(...hours.map((h) => h!.startMin));
    const close = Math.min(...hours.map((h) => h!.endMin));
    const dayStart = zonedTimeToUtc(`${day}T00:00`, timezone).getTime();
    const dayEnd = zonedTimeToUtc(`${addDaysToKey(day, 1)}T00:00`, timezone).getTime();

    for (let m = Math.ceil((open + travel) / STEP_MIN) * STEP_MIN; m + length <= close && m < 24 * 60; m += STEP_MIN) {
      const startMs = zonedTimeToUtc(`${day}T${hhmm(m)}`, timezone).getTime();
      if (startMs < earliest) continue;
      const endMs = startMs + length * 60_000;
      const free = workers.every((w, k) => {
        const mine = visits[k];
        if (w.maxVisitsPerDay) {
          const count = mine.filter((v) => v.s >= dayStart && v.s < dayEnd && v.status !== "cancelled" && v.status !== "no_show").length;
          if (count >= w.maxVisitsPerDay) return false;
        }
        return !mine.some((v) => {
          if (FINAL.includes(v.status)) return false;
          const gap = travelGapMs(v.a, travel);
          return v.s < endMs + gap && v.e + gap > startMs;
        });
      });
      if (free) return { start: new Date(startMs).toISOString(), timezone };
    }
  }
  return { start: null, timezone };
}

const WINDOW_MINUTES: Record<string, [number, number]> = {
  morning: [6 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 21 * 60],
};
const SPREAD_DAYS = 14;

/**
 * Who an online booking with no fixed time goes to: active, set up for the service and area, working the preferred day
 * (or within two weeks) and part of day with a long enough gap, under their daily limit. Fewest visits ahead wins; null when nobody fits.
 */
export async function pickStaffForBooking(
  subAccountId: string,
  service: { id: string; durationMinutes?: number | null },
  address: ServiceAddress,
  day: string | null,
  window: string,
): Promise<{ id: string; name: string; start: string; minutes: number; label: string } | null> {
  const db = getAdminDb();
  const timezone = await workspaceTimezone(subAccountId);
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
      return mine.length === 0 || (!!areaId && mine.includes(areaId));
    });
  if (workers.length === 0) return null;

  const now = Date.now();
  const today = zonedDateKey(new Date(now), timezone);
  const days = day ? [day] : Array.from({ length: SPREAD_DAYS }, (_, i) => addDaysToKey(today, i));
  const from = zonedTimeToUtc(`${days[0]}T00:00`, timezone).getTime();
  const to = zonedTimeToUtc(`${addDaysToKey(days[days.length - 1], 1)}T00:00`, timezone).getTime();
  const length = Math.min(Math.max(service.durationMinutes && service.durationMinutes > 0 ? service.durationMinutes : 60, 15), 8 * 60);
  const bounds = WINDOW_MINUTES[window] ?? [0, 24 * 60];
  const travel = await serviceTravelMinutes(service.id);

  const scored: { w: FieldWorker; load: number; startMs: number }[] = [];
  await Promise.all(
    workers.map(async (w) => {
      const snap = await db
        .collection("visits")
        .where("subAccountId", "==", subAccountId)
        .where("workerIds", "array-contains", w.id)
        .where("scheduledStart", ">=", Timestamp.fromMillis(from - 24 * 3_600_000))
        .where("scheduledStart", "<", Timestamp.fromMillis(to))
        .get();
      const visits = snap.docs
        .map((d) => d.data() as Visit)
        .map((v) => ({ s: toMs(v.scheduledStart), e: toMs(v.scheduledEnd), status: v.status, a: cleanTravelMinutes(v.travelMinutes) }))
        .filter((v): v is { s: number; e: number; status: Visit["status"]; a: number } => v.s !== null && v.e !== null);

      let firstMs = 0;
      const fits = days.some((d) => {
        const hours = workerHoursOn(w, d);
        if (!hours) return false;
        const open = Math.max(hours.startMin, bounds[0]);
        const close = Math.min(hours.endMin, bounds[1]);
        const dayStart = zonedTimeToUtc(`${d}T00:00`, timezone).getTime();
        const dayEnd = zonedTimeToUtc(`${addDaysToKey(d, 1)}T00:00`, timezone).getTime();
        if (w.maxVisitsPerDay) {
          const count = visits.filter((v) => v.s >= dayStart && v.s < dayEnd && v.status !== "cancelled" && v.status !== "no_show").length;
          if (count >= w.maxVisitsPerDay) return false;
        }
        for (let m = Math.ceil((open + travel) / STEP_MIN) * STEP_MIN; m + length <= close && m < 24 * 60; m += STEP_MIN) {
          const s = zonedTimeToUtc(`${d}T${hhmm(m)}`, timezone).getTime();
          if (s < now) continue;
          const e = s + length * 60_000;
          if (
            !visits.some((v) => {
              if (FINAL.includes(v.status)) return false;
              const gap = travelGapMs(v.a, travel);
              return v.s < e + gap && v.e + gap > s;
            })
          ) {
            firstMs = s;
            return true;
          }
        }
        return false;
      });
      if (fits) {
        scored.push({ w, load: visits.filter((v) => v.s >= now && v.status !== "cancelled" && v.status !== "no_show").length, startMs: firstMs });
      }
    }),
  );
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.load - b.load || a.startMs - b.startMs || a.w.name.localeCompare(b.w.name));
  const best = scored[0];
  return {
    id: best.w.id,
    name: best.w.name,
    start: new Date(best.startMs).toISOString(),
    minutes: length,
    label: formatInZone(new Date(best.startMs), timezone, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }),
  };
}
