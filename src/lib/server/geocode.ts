import "server-only";

import type { GeoPoint } from "@/lib/field-services/geo";

function token(): string {
  return (process.env.MAPBOX_GEOCODING_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "").trim();
}

export function geocodingConfigured(): boolean {
  return token() !== "";
}

/** One address to a point, or null when it can't be found, no token is set or Mapbox is slow. Never throws. */
export async function geocode(query: string, country?: string): Promise<(GeoPoint & { label: string }) | null> {
  const key = token();
  const q = query.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!key || !q) return null;
  const url = new URL("https://api.mapbox.com/search/geocode/v6/forward");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "1");
  url.searchParams.set("access_token", key);
  if (country && /^[A-Za-z]{2}$/.test(country)) url.searchParams.set("country", country.toLowerCase());
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4_000), cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      features?: { geometry?: { coordinates?: number[] }; properties?: { full_address?: string; name?: string } }[];
    };
    const f = data.features?.[0];
    const c = f?.geometry?.coordinates;
    if (!c || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
    return { lng: c[0], lat: c[1], label: String(f?.properties?.full_address ?? f?.properties?.name ?? q).slice(0, 200) };
  } catch {
    return null;
  }
}
