import { NextResponse } from "next/server";
import { addressSuggestConfigured, suggestAddresses } from "@/lib/server/address-suggest";

export const dynamic = "force-dynamic";

// In-memory limiter: dampens a bot spending the Mapbox quota. Per instance, resets on cold start.
const WINDOW_MS = 60_000;
const PER_IP = 40;
const MAX_KEYS = 10_000;
const hits = new Map<string, { count: number; start: number }>();

function limited(ip: string): boolean {
  const now = Date.now();
  if (hits.size > MAX_KEYS) {
    for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
    if (hits.size > MAX_KEYS) hits.clear();
  }
  const cur = hits.get(ip);
  if (!cur || now - cur.start > WINDOW_MS) {
    hits.set(ip, { count: 1, start: now });
    return false;
  }
  cur.count += 1;
  return cur.count > PER_IP;
}

/**
 * Address suggestions as someone types. Public on purpose: the online booking page has no login.
 * It returns only suggestions, never anything stored.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (limited(ip)) return NextResponse.json({ suggestions: [] }, { status: 429, headers: { "Retry-After": "60" } });
  if (!addressSuggestConfigured()) return NextResponse.json({ suggestions: [], configured: false });

  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const suggestions = await suggestAddresses({
    q: url.searchParams.get("q") ?? "",
    countries: (url.searchParams.get("country") ?? "").split(",").filter(Boolean),
    near: url.searchParams.has("lat") && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
  });
  return NextResponse.json({ suggestions, configured: true }, { headers: { "Cache-Control": "no-store" } });
}
