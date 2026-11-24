import type { ServiceAddress } from "@/types/field-services";

export function sanitizeServiceAddress(input: unknown): ServiceAddress | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const s = (v: unknown, max: number) =>
    typeof v === "string" ? v.trim().slice(0, max) : "";

  const line1 = s(raw.line1, 200);
  const city = s(raw.city, 100);
  const region = s(raw.region, 100);
  const postcode = s(raw.postcode, 20);
  if (!line1 && !city && !postcode) return null;

  const country = s(raw.country, 2).toUpperCase();
  const line2 = s(raw.line2, 200);
  return {
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    region,
    postcode,
    country,
    lat: null,
    lng: null,
    geocodeStatus: "not_requested",
  };
}

export function formatServiceAddress(a: ServiceAddress | null | undefined): string {
  if (!a) return "";
  return [a.line1, a.line2, a.city, [a.region, a.postcode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

export function sameServiceAddress(a: ServiceAddress, b: ServiceAddress): boolean {
  const key = (x: ServiceAddress) =>
    `${x.line1}|${x.postcode}`.toLowerCase().replace(/\s+/g, "");
  return key(a) === key(b);
}
