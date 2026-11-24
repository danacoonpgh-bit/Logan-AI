import "server-only";

import type { AddressSuggestion } from "@/types/address";

/** The markets the picker serves. */
export const ADDRESS_COUNTRIES = ["AU", "CA", "US", "GB"] as const;

function token(): string {
  return (process.env.MAPBOX_GEOCODING_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "").trim();
}

export function addressSuggestConfigured(): boolean {
  return token() !== "";
}

interface Ctx {
  name?: string;
  region_code?: string;
  country_code?: string;
  address_number?: string;
  street_name?: string;
}
interface Feature {
  id?: string;
  geometry?: { coordinates?: number[] };
  properties?: {
    mapbox_id?: string;
    name?: string;
    full_address?: string;
    context?: {
      address?: Ctx;
      street?: Ctx;
      locality?: Ctx;
      place?: Ctx;
      region?: Ctx;
      postcode?: Ctx;
      country?: Ctx;
    };
  };
}

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Street-address suggestions for what someone has typed so far. Empty on any failure or when no token is set. */
export async function suggestAddresses(input: { q: string; countries?: string[]; near?: { lat: number; lng: number } | null }): Promise<AddressSuggestion[]> {
  const key = token();
  const q = clean(input.q, 120);
  if (!key || q.length < 3) return [];
  const allowed = (input.countries ?? []).map((c) => c.toUpperCase()).filter((c) => (ADDRESS_COUNTRIES as readonly string[]).includes(c));
  const countries = allowed.length > 0 ? allowed : [...ADDRESS_COUNTRIES];
  const url = new URL("https://api.mapbox.com/search/geocode/v6/forward");
  url.searchParams.set("q", q);
  url.searchParams.set("autocomplete", "true");
  url.searchParams.set("types", "address");
  url.searchParams.set("limit", "5");
  url.searchParams.set("language", "en");
  url.searchParams.set("country", countries.map((c) => c.toLowerCase()).join(","));
  if (input.near && Number.isFinite(input.near.lat) && Number.isFinite(input.near.lng)) {
    url.searchParams.set("proximity", `${input.near.lng},${input.near.lat}`);
  }
  // Mapbox only lets saved addresses be kept under its permanent geocoding plan.
  if (process.env.MAPBOX_PERMANENT_GEOCODING === "true") url.searchParams.set("permanent", "true");
  url.searchParams.set("access_token", key);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4_000), cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { features?: Feature[] };
    const out: AddressSuggestion[] = [];
    for (const f of data.features ?? []) {
      const c = f.geometry?.coordinates;
      const p = f.properties;
      if (!p || !c || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      const ctx = p.context ?? {};
      const country = clean(ctx.country?.country_code, 2).toUpperCase();
      if (!(ADDRESS_COUNTRIES as readonly string[]).includes(country)) continue;
      const number = clean(ctx.address?.address_number, 20);
      const street = clean(ctx.street?.name ?? ctx.address?.street_name, 120);
      const line1 = clean(p.name, 160) || [number, street].filter(Boolean).join(" ");
      if (!line1) continue;
      // Australian suburbs come back as localities, elsewhere the city is the place.
      const city =
        country === "AU" ? clean(ctx.locality?.name ?? ctx.place?.name, 100) : clean(ctx.place?.name ?? ctx.locality?.name, 100);
      out.push({
        id: clean(p.mapbox_id ?? f.id, 200) || `${c[0]},${c[1]}`,
        label: clean(p.full_address, 220) || [line1, city].filter(Boolean).join(", "),
        line1,
        city,
        region: clean(ctx.region?.region_code ?? ctx.region?.name, 100),
        postcode: clean(ctx.postcode?.name, 20),
        country,
        lat: c[1],
        lng: c[0],
      });
    }
    return out;
  } catch {
    return [];
  }
}
