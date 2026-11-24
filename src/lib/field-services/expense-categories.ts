import { formatMoneyCode } from "@/lib/field-services/money";

export const EXPENSE_CATEGORIES: Record<string, string> = {
  fuel: "Fuel",
  parking_tolls: "Parking and tolls",
  meals: "Meals",
  tools_materials: "Tools and materials",
  accommodation: "Accommodation",
  travel: "Travel and transport",
  phone: "Phone",
  other: "Other",
};

export function categoryLabel(category: string): string {
  return Object.hasOwn(EXPENSE_CATEGORIES, category) ? EXPENSE_CATEGORIES[category] : "Other";
}

/** One total per currency, for example "$40.00 · NZ$10.00". */
export function expenseTotalsText(list: { currency: string; amountMinor: number }[]): string {
  return [...new Set(list.map((e) => e.currency))]
    .map((c) => formatMoneyCode(c, list.filter((e) => e.currency === c).reduce((sum, e) => sum + e.amountMinor, 0)))
    .join(" · ");
}
