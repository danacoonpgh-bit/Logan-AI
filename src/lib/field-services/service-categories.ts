/** The category every service starts in, and where a service lands when its own category is removed. */
export const DEFAULT_SERVICE_CATEGORY = "Default";
export const MAX_SERVICE_CATEGORIES = 20;

export function serviceCategoryList(config: { serviceCategories?: string[] } | null | undefined): string[] {
  const list = config?.serviceCategories;
  return Array.isArray(list) && list.length > 0 ? list : [DEFAULT_SERVICE_CATEGORY];
}

/** The listed category a service belongs to, or Default when it has none or its category was removed. */
export function serviceCategoryOf(list: string[], raw: unknown): string {
  const wanted = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return list.find((c) => c.toLowerCase() === wanted) ?? DEFAULT_SERVICE_CATEGORY;
}

/** Cleans a typed list: trimmed, no repeats, Default always first. Returns an error message for a bad list. */
export function cleanServiceCategories(raw: unknown): { list: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "Send the categories as a list." };
  const out: string[] = [DEFAULT_SERVICE_CATEGORY];
  for (const item of raw) {
    if (typeof item !== "string") return { error: "Each category needs a name." };
    const name = item.trim().replace(/\s+/g, " ");
    if (!name) continue;
    if (name.length > 40) return { error: "A category name can be at most 40 characters." };
    if (!out.some((c) => c.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  if (out.length > MAX_SERVICE_CATEGORIES) return { error: `Use at most ${MAX_SERVICE_CATEGORIES} categories.` };
  return { list: out };
}
