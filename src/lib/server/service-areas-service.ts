import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { parsePostcodeList } from "@/lib/field-services/postcodes";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { geocode, geocodingConfigured } from "@/lib/server/geocode";
import { KM_PER_MILE } from "@/lib/field-services/geo";
import {
  MAX_SERVICE_AREAS,
  MAX_SERVICE_AREA_POSTCODES,
  type ServiceArea,
} from "@/types/field-services";

export interface ServiceAreaInput {
  name?: string;
  country?: string;
  postcodes?: string | string[];
  travelFeeCents?: number | null;
  /** "radius" for an area measured from a point; anything else is a postcode area. */
  type?: string;
  centerAddress?: string;
  radius?: number;
  radiusUnit?: string;
}

function areasCol(subAccountId: string) {
  return getAdminDb().collection(`subAccounts/${subAccountId}/serviceAreas`);
}

function parseInput(body: ServiceAreaInput, requireAll: boolean) {
  const out: {
    name?: string;
    postcodes?: string[];
    travelFeeCents?: number | null;
  } = {};

  if (body.name !== undefined || requireAll) {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) throw new FieldServicesError("Give the area a name.");
    out.name = name;
  }
  if (body.postcodes !== undefined || requireAll) {
    const country =
      typeof body.country === "string" && body.country.trim()
        ? body.country.trim().toUpperCase().slice(0, 2)
        : "";
    if (!country) throw new FieldServicesError("Choose the country these postcodes belong to.");
    const text = Array.isArray(body.postcodes)
      ? body.postcodes.join(" ")
      : (body.postcodes ?? "");
    const codes = parsePostcodeList(country, text);
    if (codes.length === 0) {
      throw new FieldServicesError("Add at least one postcode.");
    }
    if (codes.length > MAX_SERVICE_AREA_POSTCODES) {
      throw new FieldServicesError(
        `An area can hold at most ${MAX_SERVICE_AREA_POSTCODES} postcodes.`,
      );
    }
    out.postcodes = codes;
  }
  if (body.travelFeeCents !== undefined) {
    if (body.travelFeeCents === null) {
      out.travelFeeCents = null;
    } else if (
      typeof body.travelFeeCents === "number" &&
      Number.isFinite(body.travelFeeCents) &&
      body.travelFeeCents >= 0
    ) {
      out.travelFeeCents = Math.round(body.travelFeeCents);
    } else {
      throw new FieldServicesError("Travel fee must be zero or more.");
    }
  }
  return out;
}

/** Turns the typed centre and radius into stored fields. Needs a geocoder, so it can refuse when none is set up. */
async function parseRadius(body: ServiceAreaInput) {
  const address = typeof body.centerAddress === "string" ? body.centerAddress.trim().slice(0, 200) : "";
  if (!address) throw new FieldServicesError("Enter the address the radius is measured from.");
  const radius = typeof body.radius === "number" && Number.isFinite(body.radius) ? body.radius : 0;
  if (radius <= 0 || radius > 1_000) throw new FieldServicesError("Enter a radius between 0 and 1,000.");
  const unit = body.radiusUnit === "mi" ? "mi" : "km";
  if (!geocodingConfigured()) {
    throw new FieldServicesError("Radius areas need a Mapbox token on this deployment (NEXT_PUBLIC_MAPBOX_TOKEN).");
  }
  const country = typeof body.country === "string" ? body.country.trim().slice(0, 2) : "";
  const point = await geocode(address, country);
  if (!point) throw new FieldServicesError("We couldn't find that address. Check it and try again.");
  return {
    center: { lat: point.lat, lng: point.lng, label: point.label },
    radiusKm: Math.round(radius * (unit === "mi" ? KM_PER_MILE : 1) * 100) / 100,
    radiusUnit: unit as "km" | "mi",
  };
}

export async function createServiceArea(input: {
  subAccountId: string;
  createdByUid: string;
  body: ServiceAreaInput;
}): Promise<{ id: string }> {
  const isRadius = input.body.type === "radius";
  const fields = parseInput(isRadius ? { ...input.body, postcodes: undefined } : input.body, !isRadius);
  if (isRadius && !fields.name) {
    const name = typeof input.body.name === "string" ? input.body.name.trim().slice(0, 80) : "";
    if (!name) throw new FieldServicesError("Give the area a name.");
    fields.name = name;
  }
  const radiusFields = isRadius ? await parseRadius(input.body) : null;
  const col = areasCol(input.subAccountId);
  const count = (await col.count().get()).data().count;
  if (count >= MAX_SERVICE_AREAS) {
    throw new FieldServicesError(
      `A workspace can have at most ${MAX_SERVICE_AREAS} service areas.`,
    );
  }
  const ref = col.doc();
  const doc: Omit<ServiceArea, "id"> = {
    name: fields.name!,
    type: isRadius ? "radius" : "zip",
    postcodes: isRadius ? [] : fields.postcodes!,
    ...(radiusFields ?? {}),
    travelFeeCents: fields.travelFeeCents ?? null,
    createdByUid: input.createdByUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);
  return { id: ref.id };
}

export async function updateServiceArea(input: {
  subAccountId: string;
  areaId: string;
  body: ServiceAreaInput;
}): Promise<void> {
  const ref = areasCol(input.subAccountId).doc(input.areaId);
  if (!(await ref.get()).exists) {
    throw new FieldServicesError("Service area not found.", 404);
  }
  const fields = parseInput(input.body, false);
  if (Object.keys(fields).length === 0) {
    throw new FieldServicesError("Nothing to update.");
  }
  await ref.update({ ...fields, updatedAt: FieldValue.serverTimestamp() });
}

export async function deleteServiceArea(input: {
  subAccountId: string;
  areaId: string;
}): Promise<void> {
  const ref = areasCol(input.subAccountId).doc(input.areaId);
  if (!(await ref.get()).exists) {
    throw new FieldServicesError("Service area not found.", 404);
  }
  // Staff limited to this area come off it first. Left on, they would match no area and drop out of every open time.
  const db = getAdminDb();
  const everyone = await db.collection("fieldWorkers").where("subAccountId", "==", input.subAccountId).get();
  const staff = everyone.docs.filter((d) => {
    const ids = d.data().areaIds;
    return Array.isArray(ids) && ids.includes(input.areaId);
  });
  for (let i = 0; i < staff.length; i += 400) {
    const batch = db.batch();
    for (const d of staff.slice(i, i + 400)) {
      batch.update(d.ref, { areaIds: FieldValue.arrayRemove(input.areaId), updatedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
  }
  await ref.delete();
}
