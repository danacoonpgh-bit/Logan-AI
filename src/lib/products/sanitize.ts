import type { Product } from "@/types/products";

/** Product payload sanitizer for create and update. In lib/ because Next 15 forbids extra exports from route files. */

export interface CreateProductPayload {
  name?: string;
  description?: string;
  unitPriceCents?: number;
  currency?: string;
  active?: boolean;
  bumpEligible?: boolean;
  bumpHeadline?: string;
  kind?: string;
  durationMinutes?: number;
  travelMinutes?: number;
  variants?: unknown;
  minLeadHours?: number | null;
  depositPercent?: number | null;
  category?: string;
  color?: string;
  billingType?: string;
  estimateRateCents?: number;
  staffRequired?: number;
}

export function sanitizeProductPayload(
  body: CreateProductPayload,
): Partial<Product> {
  const out: Partial<Product> = {};

  if (typeof body.name === "string") {
    out.name = body.name.trim().slice(0, 200);
  }
  if (typeof body.description === "string") {
    out.description = body.description.trim().slice(0, 2_000);
  }
  if (
    typeof body.unitPriceCents === "number" &&
    Number.isFinite(body.unitPriceCents)
  ) {
    out.unitPriceCents = Math.max(0, Math.round(body.unitPriceCents));
  }
  if (typeof body.currency === "string" && body.currency.trim()) {
    out.currency = body.currency.trim().toUpperCase().slice(0, 3);
  }
  if (typeof body.active === "boolean") {
    out.active = body.active;
  }
  if (typeof body.bumpEligible === "boolean") {
    out.bumpEligible = body.bumpEligible;
  }
  if (typeof body.bumpHeadline === "string") {
    // Anything longer belongs in the product description, which checkout falls back to.
    out.bumpHeadline = body.bumpHeadline.trim().slice(0, 140);
  }

  if (body.kind === "product" || body.kind === "service") {
    out.kind = body.kind;
  }
  if (
    typeof body.durationMinutes === "number" &&
    Number.isFinite(body.durationMinutes)
  ) {
    out.durationMinutes = Math.max(0, Math.min(1_440, Math.round(body.durationMinutes)));
  }
  if (typeof body.travelMinutes === "number" && Number.isFinite(body.travelMinutes)) {
    out.travelMinutes = Math.max(0, Math.min(240, Math.round(body.travelMinutes)));
  }
  if (Array.isArray(body.variants)) {
    const seen = new Set<string>();
    out.variants = body.variants
      .slice(0, 8)
      .map((raw): NonNullable<Product["variants"]>[number] | null => {
        const v = (raw ?? {}) as Record<string, unknown>;
        const name = typeof v.name === "string" ? v.name.trim().slice(0, 60) : "";
        if (!name) return null;
        let id = typeof v.id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(v.id) ? v.id : "";
        if (!id || seen.has(id)) id = `v${seen.size + 1}${Math.random().toString(36).slice(2, 6)}`;
        seen.add(id);
        const mins = typeof v.durationMinutes === "number" && Number.isFinite(v.durationMinutes) ? v.durationMinutes : 0;
        const cents = typeof v.unitPriceCents === "number" && Number.isFinite(v.unitPriceCents) ? v.unitPriceCents : 0;
        return {
          id,
          name,
          durationMinutes: Math.max(0, Math.min(1_440, Math.round(mins))),
          unitPriceCents: Math.max(0, Math.round(cents)),
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
  }
  if (body.depositPercent === null) {
    out.depositPercent = null;
  } else if (typeof body.depositPercent === "number" && Number.isFinite(body.depositPercent)) {
    out.depositPercent = Math.max(0, Math.min(100, Math.round(body.depositPercent)));
  }
  if (body.minLeadHours === null) {
    out.minLeadHours = null;
  } else if (typeof body.minLeadHours === "number" && Number.isFinite(body.minLeadHours)) {
    out.minLeadHours = Math.max(0, Math.min(2_160, Math.round(body.minLeadHours)));
  }
  if (typeof body.category === "string") {
    out.category = body.category.trim().slice(0, 60);
  }
  if (typeof body.staffRequired === "number" && Number.isInteger(body.staffRequired) && body.staffRequired >= 1 && body.staffRequired <= 5) {
    out.staffRequired = body.staffRequired;
  }
  if (typeof body.estimateRateCents === "number" && Number.isFinite(body.estimateRateCents)) {
    out.estimateRateCents = Math.max(0, Math.min(10_000_000, Math.round(body.estimateRateCents)));
  }
  if (body.billingType === "time_and_materials" || body.billingType === "lump_sum") {
    out.billingType = body.billingType;
  }
  if (typeof body.color === "string") {
    const c = body.color.trim();
    if (c === "") out.color = "";
    else if (/^#[0-9a-fA-F]{6}$/.test(c)) out.color = c.toLowerCase();
  }

  return out;
}
