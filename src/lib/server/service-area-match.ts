import "server-only";

import { distanceKm } from "@/lib/field-services/geo";
import { matchServiceArea, type AreaMatch } from "@/lib/field-services/postcodes";
import { geocode } from "@/lib/server/geocode";
import type { ServiceArea } from "@/types/field-services";

/**
 * Whether an address is inside any service area: postcode areas by postcode, radius areas by distance from their centre.
 * Out of area is only answered when every kind of area could be checked, otherwise unknown.
 */
export async function matchAreasForAddress(
  areas: ServiceArea[],
  address: { line1?: string; city?: string; region?: string; postcode?: string | null; country: string },
): Promise<AreaMatch> {
  const radius = areas.filter((a) => a.type === "radius" && a.center && a.radiusKm);
  const zip = areas.filter((a) => a.type !== "radius");
  const zipResult = zip.length ? matchServiceArea(zip, address.country, address.postcode) : null;
  if (zipResult?.status === "in_area") return zipResult;

  let radiusChecked = false;
  if (radius.length > 0) {
    const query = [address.line1, address.city, address.region, address.postcode].filter(Boolean).join(", ");
    const point = await geocode(query, address.country);
    if (point) {
      radiusChecked = true;
      let best: { area: ServiceArea; km: number } | null = null;
      for (const a of radius) {
        const km = distanceKm(point, a.center!);
        if (km <= (a.radiusKm as number) && (!best || km < best.km)) best = { area: a, km };
      }
      if (best) return { status: "in_area", area: best.area };
    }
  }

  const zipChecked = zipResult !== null && zipResult.status !== "unknown";
  const everyKindChecked = (zip.length === 0 || zipChecked) && (radius.length === 0 || radiusChecked);
  return everyKindChecked && zip.length + radius.length > 0 ? { status: "out_of_area" } : { status: "unknown" };
}
