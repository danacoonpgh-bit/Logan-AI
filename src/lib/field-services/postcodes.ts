import type { ServiceArea } from "@/types/field-services";

export function normalizePostcode(country: string, raw: string): string {
  const cleaned = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cc = (country ?? "").toUpperCase();
  if (cc === "US") {
    return cleaned.slice(0, 5);
  }
  return cleaned;
}

// Prefixes are cut on a real boundary, so SW1 never matches SW10.
function matchKeys(country: string, postcode: string): string[] {
  const cc = (country ?? "").toUpperCase();
  const keys = [postcode];
  if (cc === "GB" && postcode.length > 3) {
    keys.push(postcode.slice(0, -3));
  } else if (cc === "CA" && postcode.length > 3) {
    keys.push(postcode.slice(0, 3));
  } else if (cc === "US" && postcode.length === 5) {
    keys.push(postcode.slice(0, 3));
  } else if (cc === "IE" && postcode.length > 3) {
    keys.push(postcode.slice(0, 3));
  }
  return keys;
}

export type AreaMatch =
  | { status: "in_area"; area: ServiceArea }
  | { status: "out_of_area" }
  | { status: "unknown" };

export function matchServiceArea(
  areas: ServiceArea[],
  country: string,
  rawPostcode: string | null | undefined,
): AreaMatch {
  if (areas.length === 0) return { status: "unknown" };
  const postcode = normalizePostcode(country, rawPostcode ?? "");
  if (!postcode) return { status: "unknown" };
  const keys = matchKeys(country, postcode);
  for (const area of areas) {
    for (const key of keys) {
      if (area.postcodes.includes(key)) return { status: "in_area", area };
    }
  }
  return { status: "out_of_area" };
}

const INWARD_GROUP: Record<string, RegExp> = {
  GB: /^\d[A-Z]{2}$/,
  CA: /^\d[A-Z]\d$/,
  IE: /^[A-Z0-9]{4}$/,
};

export function parsePostcodeList(country: string, text: string): string[] {
  const cc = (country ?? "").toUpperCase();
  const inward = INWARD_GROUP[cc];
  const seen = new Set<string>();
  for (const piece of (text ?? "").split(/[,;\n]+/)) {
    const tokens = piece
      .trim()
      .toUpperCase()
      .split(/\s+/)
      .filter(Boolean);
    const parts: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const next = tokens[i + 1];
      if (inward && next && inward.test(next) && !inward.test(tokens[i])) {
        parts.push(tokens[i] + next);
        i++;
      } else {
        parts.push(tokens[i]);
      }
    }
    for (const part of parts) {
      const code = normalizePostcode(country, part);
      if (code.length >= 2 && code.length <= 10) seen.add(code);
    }
  }
  return [...seen];
}
