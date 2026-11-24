import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { distanceKm, type GeoPoint } from "@/lib/field-services/geo";
import { cleanTravelMinutes } from "@/lib/field-services/travel";
import { geocode } from "@/lib/server/geocode";

/** A rough town speed and a road factor over the straight line; good enough to rank slots without a routing call. */
const KMH = 35;
const ROAD_FACTOR = 1.35;
const CACHE_MAX = 500;
const CACHE_MS = 6 * 3_600_000;

export interface FitStop {
  start: number;
  end: number;
  pt: GeoPoint | null;
}

const cache = new Map<string, { pt: GeoPoint; at: number }>();

/** Geocoding with a small per-instance memory so a busy booking page doesn't look the same address up again and again. */
export async function cachedGeocode(query: string, country?: string): Promise<GeoPoint | null> {
  const key = `${country ?? ""}|${query.trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.pt;
  const found = await geocode(query, country);
  if (!found) return null;
  const pt = { lng: found.lng, lat: found.lat };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { pt, at: Date.now() });
  return pt;
}

export function travelMinutes(a: GeoPoint, b: GeoPoint): number {
  return (distanceKm(a, b) * ROAD_FACTOR * 60) / KMH;
}

/** The travel time a service keeps free either side of each job. */
export async function serviceTravelMinutes(serviceId: string): Promise<number> {
  const d = await getAdminDb().doc(`products/${serviceId}`).get();
  return cleanTravelMinutes(d.data()?.travelMinutes);
}

/**
 * Extra driving, in minutes, a new visit at `customer` adds to one person's day. With no visits that day it is the trip
 * from where their day starts; unknown places add none. Only ranks people and times; the travel allowance decides what is allowed.
 */
export function detourMinutes(
  stops: FitStop[],
  home: GeoPoint | null,
  customer: GeoPoint,
  startMs: number,
  endMs: number,
  returnTo: GeoPoint | null = null,
): number {
  let prev: FitStop | null = null;
  let next: FitStop | null = null;
  for (const s of stops) {
    if (s.end <= startMs && (!prev || s.end > prev.end)) prev = s;
    if (s.start >= endMs && (!next || s.start < next.start)) next = s;
  }
  const from = prev ? prev.pt : home;
  // With return to base on, the day ends at the start point, so a last visit also adds the drive home.
  const to = next ? next.pt : from ? returnTo : null;
  const inbound = from ? travelMinutes(from, customer) : 0;
  const outbound = to ? travelMinutes(customer, to) : 0;
  const direct = from && to ? travelMinutes(from, to) : 0;
  return Math.max(0, inbound + outbound - direct);
}

/** How much worse than the day's best a slot may be and still be offered. */
export const FIT_BASE_MIN = 15;
export const FIT_SLACK_MIN = 10;
