import "server-only";

import { bookingTotals } from "@/lib/field-services/booking-price";
import { cardPayAvailable, depositMinorFor } from "@/lib/server/field-booking-deposit-service";
import { loadBookableAddOns } from "@/lib/server/field-addons-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import type { PublicBookingService } from "@/lib/server/field-booking-service";
import type { FieldAddOn, FieldServicesConfig, JobTax } from "@/types/field-services";
import type { SubAccountDoc } from "@/types/tenancy";

export type PayChoice = "deposit" | "full" | "in_person";

export interface PayOptions {
  deposit: boolean;
  full: boolean;
  inPerson: boolean;
}

export interface PricedBooking {
  currency: string;
  lines: { description: string; priceMinor: number }[];
  /** The prices as typed, added up. */
  priceMinor: number;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
  tax: JobTax | null;
  /** The deposit due now when the customer pays a deposit, tax included. */
  depositMinor: number;
  options: PayOptions;
  extraMinutes: number;
  addOns: FieldAddOn[];
}

/** The workspace's tax as a snapshot, or null when it charges none. */
export function taxOf(config: Pick<FieldServicesConfig, "taxName" | "taxPercent" | "pricesIncludeTax">): JobTax | null {
  const percent = Number(config.taxPercent);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return { name: (config.taxName || "Tax").slice(0, 30), percent, inclusive: config.pricesIncludeTax === true };
}

/** The add-ons the customer ticked. Only active ones that go with the chosen services count; anything else is refused. */
export async function pickAddOns(subAccountId: string, serviceIds: string[], raw: unknown): Promise<FieldAddOn[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new FieldServicesError("Those extras aren't valid.");
  const wanted = [...new Set(raw.filter((x): x is string => typeof x === "string"))].slice(0, 20);
  if (wanted.length === 0) return [];
  const available = await loadBookableAddOns(subAccountId, serviceIds);
  const picked = available.filter((a) => wanted.includes(a.id));
  if (picked.length !== wanted.length) throw new FieldServicesError("One of the extras you chose is no longer available. Please check your choices.");
  return picked;
}

/** The service as it is once the extras' time is added, so open times and the visit length allow for it. */
export function withExtraMinutes(service: PublicBookingService, minutes: number): PublicBookingService {
  if (!(minutes > 0)) return service;
  return { ...service, durationMinutes: (service.durationMinutes ?? 60) + minutes };
}

/** Everything the customer is charged, worked out here and nowhere else. */
export function priceBooking(input: {
  sub: Partial<SubAccountDoc> | null;
  config: FieldServicesConfig;
  services: PublicBookingService[];
  addOns: FieldAddOn[];
}): PricedBooking {
  const { sub, config, services, addOns } = input;
  const currency = services[0]?.currency ?? "USD";
  const lines = [
    ...services.map((s) => ({ description: s.name, priceMinor: s.priceMinor })),
    ...addOns.map((a) => ({ description: a.name, priceMinor: a.priceMinor })),
  ];
  const priceMinor = lines.reduce((sum, l) => sum + l.priceMinor, 0);
  const tax = taxOf(config);
  const totals = bookingTotals(priceMinor, tax);

  const serviceDeposit = services.reduce(
    (sum, s) => sum + depositMinorFor({ sub, config, priceMinor: s.priceMinor, currency, servicePercent: s.depositPercent }),
    0,
  );
  // Extras only add to a deposit when the services take one.
  const addOnDeposit =
    serviceDeposit > 0
      ? addOns.reduce((sum, a) => sum + depositMinorFor({ sub, config, priceMinor: a.priceMinor, currency, servicePercent: null }), 0)
      : 0;
  const depositNet = serviceDeposit + addOnDeposit;
  const depositMinor =
    priceMinor > 0 && depositNet > 0 ? Math.min(totals.totalMinor, Math.round((depositNet * totals.totalMinor) / priceMinor)) : 0;

  const card = cardPayAvailable(sub, currency) && totals.totalMinor > 0;
  const deposit = depositMinor > 0;
  const full = card && config.bookingPayInFull === true;
  // Pay in person is also what is left when no card option can be offered.
  const inPerson = config.bookingPayInPerson === true || (!deposit && !full);

  return {
    currency,
    lines,
    priceMinor,
    ...totals,
    tax,
    depositMinor,
    options: { deposit, full, inPerson },
    extraMinutes: Math.min(480, addOns.reduce((sum, a) => sum + a.extraMinutes, 0)),
    addOns,
  };
}

/** The customer's choice, checked against what is on offer. With only one option it needs no answer. */
export function payChoiceOf(options: PayOptions, raw: unknown): PayChoice {
  const offered: PayChoice[] = [
    ...(options.deposit ? (["deposit"] as const) : []),
    ...(options.full ? (["full"] as const) : []),
    ...(options.inPerson ? (["in_person"] as const) : []),
  ];
  if (raw === "deposit" || raw === "full" || raw === "in_person") {
    if (offered.includes(raw)) return raw;
    throw new FieldServicesError("That way of paying isn't available. Please choose again.");
  }
  if (offered.length === 1) return offered[0];
  throw new FieldServicesError("Choose how you would like to pay.");
}
