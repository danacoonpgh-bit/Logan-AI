"use client";

import { useMemo } from "react";
import { useTheme } from "next-themes";
import { Map as MapboxMap, Layer, Source } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import type { ServiceArea } from "@/types/field-services";

const EARTH_KM = 6371;

/** A circle on the globe as a closed ring of [lng, lat] points. */
function circleRing(lat: number, lng: number, km: number, steps = 72): [number, number][] {
  const d = km / EARTH_KM;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
    const lng2 =
      lng1 +
      Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    ring.push([(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return ring;
}

/** The saved radius areas drawn as circles, so the admin can see what they cover. */
export function ServiceAreasMap({ areas }: { areas: ServiceArea[] }) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim();
  const { resolvedTheme } = useTheme();

  const drawn = useMemo(
    () => areas.filter((a) => a.type === "radius" && a.center && (a.radiusKm ?? 0) > 0),
    [areas],
  );

  const { shapes, centers, bounds } = useMemo(() => {
    const rings = drawn.map((a) => circleRing(a.center!.lat, a.center!.lng, a.radiusKm!));
    let minLng = 180;
    let maxLng = -180;
    let minLat = 90;
    let maxLat = -90;
    for (const ring of rings) {
      for (const [lng, lat] of ring) {
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
      }
    }
    return {
      shapes: {
        type: "FeatureCollection" as const,
        features: drawn.map((a, i) => ({
          type: "Feature" as const,
          properties: { name: a.name },
          geometry: { type: "Polygon" as const, coordinates: [rings[i]] },
        })),
      },
      centers: {
        type: "FeatureCollection" as const,
        features: drawn.map((a) => ({
          type: "Feature" as const,
          properties: { name: a.name },
          geometry: { type: "Point" as const, coordinates: [a.center!.lng, a.center!.lat] },
        })),
      },
      bounds: [
        [minLng, minLat],
        [maxLng, maxLat],
      ] as [[number, number], [number, number]],
    };
  }, [drawn]);

  if (!token || drawn.length === 0) return null;

  const styleUrl =
    resolvedTheme === "dark" ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/streets-v12";
  // A new set of areas remounts the map so it fits them again.
  const mapKey = drawn.map((a) => `${a.id}:${a.radiusKm}:${a.center?.lat}:${a.center?.lng}`).join("|");

  return (
    <div className="mt-4">
      <div className="h-72 overflow-hidden rounded-lg border">
        <MapboxMap
          key={mapKey}
          mapboxAccessToken={token}
          initialViewState={{ bounds, fitBoundsOptions: { padding: 40, maxZoom: 13 } }}
          mapStyle={styleUrl}
          reuseMaps
        >
          <Source id="service-areas" type="geojson" data={shapes}>
            <Layer id="service-areas-fill" type="fill" paint={{ "fill-color": "#6366f1", "fill-opacity": 0.2 }} />
            <Layer
              id="service-areas-line"
              type="line"
              paint={{ "line-color": "#6366f1", "line-width": 2 }}
            />
          </Source>
          <Source id="service-area-centers" type="geojson" data={centers}>
            <Layer
              id="service-area-centers-dot"
              type="circle"
              paint={{
                "circle-radius": 5,
                "circle-color": "#6366f1",
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 2,
              }}
            />
          </Source>
        </MapboxMap>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        The shaded circles are the areas above. Postcode areas are not drawn.
      </p>
    </div>
  );
}
