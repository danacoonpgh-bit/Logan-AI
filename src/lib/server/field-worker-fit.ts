import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { DAY_LABELS, DAY_KEYS, hoursOf, hoursOnDay, leaveOn } from "@/lib/field-services/working-hours";
import { matchAreasForAddress } from "@/lib/server/service-area-match";
import { Timestamp } from "firebase-admin/firestore";
import { addDaysToKey, utcToZonedInput, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import type { FieldWorker, Job, ServiceArea } from "@/types/field-services";

function clock(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Soft warnings for putting these workers on a visit: outside their hours, not set up for the service, or outside their area. Never blocks. */
export async function workerFitWarnings(input: {
  subAccountId: string;
  workers: FieldWorker[];
  job: Job | undefined;
  start: Date;
  end: Date;
  anytime: boolean;
  /** The visit being edited, so it does not count against itself. */
  ignoreVisitId?: string;
}): Promise<string[]> {
  const { workers, job, start, end } = input;
  if (workers.length === 0 || !job) return [];
  const out: string[] = [];
  const zone = job.timezone || "UTC";

  const shortDate = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
  const firstDay = zonedDateKey(start, zone);
  const lastDay = zonedDateKey(end, zone);
  for (const w of workers) {
    const leave = leaveOn(w, firstDay) ?? leaveOn(w, lastDay);
    if (leave) {
      out.push(
        `${w.name} is away from ${shortDate(leave.start)} to ${shortDate(leave.end)}${leave.note ? ` (${leave.note})` : ""}.`,
      );
    }
  }

  const limited = workers.filter((w) => typeof w.maxVisitsPerDay === "number" && w.maxVisitsPerDay > 0);
  if (limited.length > 0) {
    const day = zonedDateKey(start, zone);
    const from = Timestamp.fromDate(zonedTimeToUtc(`${day}T00:00`, zone));
    const to = Timestamp.fromDate(zonedTimeToUtc(`${addDaysToKey(day, 1)}T00:00`, zone));
    for (const w of limited) {
      const snap = await getAdminDb()
        .collection("visits")
        .where("subAccountId", "==", input.subAccountId)
        .where("workerIds", "array-contains", w.id)
        .where("scheduledStart", ">=", from)
        .where("scheduledStart", "<", to)
        .get();
      const count = snap.docs.filter((d) => d.id !== input.ignoreVisitId && d.data().status !== "cancelled" && d.data().status !== "no_show").length;
      if (count >= (w.maxVisitsPerDay as number)) {
        out.push(`${w.name} already has ${count} visit${count === 1 ? "" : "s"} that day. Their limit is ${w.maxVisitsPerDay}.`);
      }
    }
  }

  if (!input.anytime) {
    const day = zonedDateKey(start, zone);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    const dayName = DAY_LABELS[DAY_KEYS[(dow + 6) % 7]];
    const startMin = Number(utcToZonedInput(start, zone).slice(11, 13)) * 60 + Number(utcToZonedInput(start, zone).slice(14, 16));
    const sameDay = zonedDateKey(end, zone) === day;
    const endMin = sameDay
      ? Number(utcToZonedInput(end, zone).slice(11, 13)) * 60 + Number(utcToZonedInput(end, zone).slice(14, 16))
      : 24 * 60;
    for (const w of workers) {
      if (leaveOn(w, day)) continue;
      const h = hoursOnDay(hoursOf(w), day);
      if (!h) out.push(`${w.name} doesn't usually work on ${dayName}.`);
      else if (startMin < h.startMin || endMin > h.endMin) {
        out.push(`${w.name} usually works ${clock(h.startMin)} to ${clock(h.endMin)} on ${dayName}.`);
      }
    }
  }

  const serviceIds = job.lineItems.map((l) => l.productId).filter((id): id is string => !!id);
  if (serviceIds.length > 0) {
    for (const w of workers) {
      const mine = w.serviceIds ?? [];
      if (mine.length > 0 && serviceIds.some((id) => !mine.includes(id))) {
        out.push(`${w.name} isn't set up for every service on this job.`);
      }
    }
  }

  const addr = job.serviceAddress;
  if (addr?.postcode && workers.some((w) => (w.areaIds ?? []).length > 0)) {
    const snap = await getAdminDb().collection(`subAccounts/${input.subAccountId}/serviceAreas`).get();
    const areas = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as ServiceArea);
    const hit = await matchAreasForAddress(areas, {
      line1: addr.line1,
      city: addr.city,
      region: addr.region,
      postcode: addr.postcode,
      country: addr.country,
    });
    if (hit.status === "in_area") {
      for (const w of workers) {
        const mine = w.areaIds ?? [];
        if (mine.length > 0 && !mine.includes(hit.area.id)) out.push(`${w.name} doesn't usually cover ${hit.area.name}.`);
      }
    }
  }
  return out;
}
