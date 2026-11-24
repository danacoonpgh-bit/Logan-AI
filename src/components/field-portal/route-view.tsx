"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Navigation } from "lucide-react";
import { useTheme } from "next-themes";
import { Layer, Map as MapboxMap, Marker, Source } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { Button, buttonVariants } from "@/components/ui/button";
import { addDaysToKey, applyClock24, formatInZone, zonedDateKey } from "@/lib/field-services/time";
import { cn } from "@/lib/utils";

interface Stop {
  visitId: string;
  jobNumber: string;
  title: string;
  address: string;
  startIso: string | null;
  endIso: string | null;
  anytime: boolean;
  timezone: string;
  status: string;
  lat: number | null;
  lng: number | null;
  driveMinutes: number | null;
}

interface RouteData {
  day: string;
  configured: boolean;
  clock24: boolean;
  stops: Stop[];
  line: [number, number][];
  totalDriveMinutes: number | null;
}

const DONE = ["completed"];

function mapsLink(stop: Stop): string {
  const to = stop.lat !== null && stop.lng !== null ? `${stop.lat},${stop.lng}` : stop.address;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(to)}&travelmode=driving`;
}

/** Every stop of the day as one trip in the maps app, from where the person is now. */
function wholeRouteLink(stops: Stop[]): string | null {
  const open = stops.filter((s) => !DONE.includes(s.status));
  if (open.length === 0) return null;
  const at = (s: Stop) => (s.lat !== null && s.lng !== null ? `${s.lat},${s.lng}` : s.address);
  // Maps takes about ten places; the link covers the first nine and the list shows the rest.
  const shown = open.slice(0, 9);
  const last = shown[shown.length - 1];
  const via = shown.slice(0, -1).map(at).join("|");
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", at(last));
  if (via) url.searchParams.set("waypoints", via);
  url.searchParams.set("travelmode", "driving");
  return url.toString();
}

/** The crew's day on a map: numbered stops in visit order, the driving between them and a link to navigate to each. */
export function RouteView({
  active,
  timezone,
  startDay = null,
  jump = null,
}: {
  active: boolean;
  timezone: string;
  /** Opens on this day when there is nothing today. */
  startDay?: string | null;
  /** A day chosen elsewhere in the app. */
  jump?: { day: string; n: number } | null;
}) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim();
  const { resolvedTheme } = useTheme();
  const today = zonedDateKey(new Date(), timezone);
  const [day, setDay] = useState(startDay ?? today);
  const [data, setData] = useState<RouteData | null>(null);
  // Follow the suggested day until the person picks one themselves.
  const picked = useRef(false);
  useEffect(() => {
    if (!picked.current && startDay) setDay(startDay);
  }, [startDay]);
  useEffect(() => {
    if (jump) {
      picked.current = true;
      setDay(jump.day);
    }
  }, [jump]);
  const choose = (d: string) => {
    picked.current = true;
    setDay(d);
  };
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) return;
    let live = true;
    setData(null);
    setFailed(false);
    fetch(`/api/field-portal/day-route?day=${day}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<RouteData>) : null))
      .then((d) => {
        if (!live) return;
        if (d) setData(d);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [active, day]);

  applyClock24(data?.clock24);
  const located = useMemo(() => (data?.stops ?? []).filter((s) => s.lat !== null && s.lng !== null), [data]);
  const bounds = useMemo(() => {
    if (located.length === 0) return null;
    let minLng = 180;
    let maxLng = -180;
    let minLat = 90;
    let maxLat = -90;
    for (const s of located) {
      minLng = Math.min(minLng, s.lng as number);
      maxLng = Math.max(maxLng, s.lng as number);
      minLat = Math.min(minLat, s.lat as number);
      maxLat = Math.max(maxLat, s.lat as number);
    }
    return [
      [minLng, minLat],
      [maxLng, maxLat],
    ] as [[number, number], [number, number]];
  }, [located]);

  const dayLabel = formatInZone(new Date(`${day}T12:00:00Z`), "UTC", { weekday: "long", day: "numeric", month: "long" });
  const whole = data ? wholeRouteLink(data.stops) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">Route</h1>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Earlier day" disabled={day <= addDaysToKey(today, -1)} onClick={() => choose(addDaysToKey(day, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <button
            type="button"
            className="min-w-32 px-2 text-center text-sm font-medium"
            onClick={() => choose(today)}
            aria-label="Go to today"
          >
            {day === today ? "Today" : dayLabel}
          </button>
          <Button variant="outline" size="icon" aria-label="Later day" disabled={day >= addDaysToKey(today, 7)} onClick={() => choose(addDaysToKey(day, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Quick day">
        {[
          ["Today", today],
          ["Tomorrow", addDaysToKey(today, 1)],
        ].map(([label, value]) => (
          <button
            key={label}
            type="button"
            aria-pressed={day === value}
            onClick={() => choose(value)}
            className={cn(
              "min-h-11 touch-manipulation rounded-lg border text-sm font-medium transition-colors",
              day === value ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted/50",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {!data && !failed && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the route…
        </p>
      )}
      {failed && <p className="text-sm text-muted-foreground">Couldn&apos;t load the route. Check your connection and try again.</p>}

      {data && data.stops.length === 0 && <p className="rounded-xl border p-4 text-sm text-muted-foreground">No visits on {day === today ? "today" : dayLabel}.</p>}

      {data && data.stops.length > 0 && (
        <>
          {token && bounds && (
            <div className="h-64 overflow-hidden rounded-xl border lg:h-96">
              <MapboxMap
                key={`${data.day}:${located.map((s) => s.visitId).join(",")}`}
                mapboxAccessToken={token}
                initialViewState={{ bounds, fitBoundsOptions: { padding: 48, maxZoom: 15 } }}
                mapStyle={resolvedTheme === "dark" ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/streets-v12"}
                reuseMaps
              >
                {data.line.length > 1 && (
                  <Source
                    id="day-route"
                    type="geojson"
                    data={{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: data.line } }}
                  >
                    <Layer id="day-route-line" type="line" paint={{ "line-color": "#2563eb", "line-width": 4, "line-opacity": 0.8 }} />
                  </Source>
                )}
                {data.stops.map((s, i) =>
                  s.lat !== null && s.lng !== null ? (
                    <Marker key={s.visitId} longitude={s.lng} latitude={s.lat} anchor="center">
                      <div
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-sm font-semibold text-white shadow",
                          DONE.includes(s.status) ? "bg-emerald-600" : "bg-primary",
                        )}
                      >
                        {i + 1}
                      </div>
                    </Marker>
                  ) : null,
                )}
              </MapboxMap>
            </div>
          )}
          {data.configured && located.length < data.stops.length && (
            <p className="text-xs text-muted-foreground">Some addresses couldn&apos;t be placed on the map. They are still in the list.</p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {data.stops.length} stop{data.stops.length === 1 ? "" : "s"}
              {data.totalDriveMinutes !== null ? ` · about ${data.totalDriveMinutes} min driving` : ""}
            </p>
            {whole && (
              <a
                href={whole}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ size: "sm" }), "touch-manipulation")}
              >
                <Navigation className="mr-1.5 h-4 w-4" /> Open whole route
              </a>
            )}
            {whole && data.stops.filter((s) => !DONE.includes(s.status)).length > 9 && (
              <p className="w-full text-xs text-muted-foreground">The maps link covers the first 9 open stops. Use the arrow on later stops.</p>
            )}
          </div>

          <ol className="divide-y rounded-xl border">
            {data.stops.map((s, i) => (
              <li key={s.visitId} className="flex items-start gap-3 p-3">
                <span
                  className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white",
                    DONE.includes(s.status) ? "bg-emerald-600" : "bg-primary",
                  )}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {s.anytime || !s.startIso
                      ? "Any time"
                      : `${formatInZone(new Date(s.startIso), s.timezone, { hour: "numeric", minute: "2-digit" })}${
                          s.endIso ? ` to ${formatInZone(new Date(s.endIso), s.timezone, { hour: "numeric", minute: "2-digit" })}` : ""
                        }`}
                    {DONE.includes(s.status) && <span className="ml-2 text-xs font-normal text-emerald-600">Done</span>}
                  </p>
                  <p className="truncate text-sm">
                    {s.title} <span className="text-muted-foreground">{s.jobNumber}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{s.address || "No address"}</p>
                  {s.driveMinutes !== null && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{s.driveMinutes} min drive from the stop before</p>
                  )}
                </div>
                {s.address && (
                  <a
                    href={mapsLink(s)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Navigate to stop ${i + 1}`}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0 touch-manipulation")}
                  >
                    <Navigation className="h-4 w-4" />
                  </a>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
