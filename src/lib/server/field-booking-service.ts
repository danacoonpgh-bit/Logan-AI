import "server-only";
import { bookingStyleOf, type BookingStyleId } from "@/lib/field-services/booking-styles";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { fieldServicesAvailable } from "@/lib/field-services/availability";
import { isDayKey } from "@/lib/field-services/intervals";
import { jobStatusUrl } from "@/lib/field-services/job-status-token";
import { withArticle } from "@/lib/field-services/terms";
import { serviceCategoryList, serviceCategoryOf } from "@/lib/field-services/service-categories";
import { matchAreasForAddress } from "@/lib/server/service-area-match";
import { addDaysToKey, zonedDateKey } from "@/lib/field-services/time";
import { reconcileBookingContact } from "@/lib/booking/contact-reconcile";
import { claimBookingSlot } from "@/lib/server/field-booking-slots";
import { pickStaffForBooking } from "@/lib/server/field-first-slot";
import { createVisit, findScheduleClashes } from "@/lib/server/field-visits-service";
import { serviceTravelMinutes } from "@/lib/server/field-slot-fit";
import { createDepositInvoice, depositMinorFor, DEPOSIT_HOLD_MS, releaseHold } from "@/lib/server/field-booking-deposit-service";
import { loadBookableAddOns } from "@/lib/server/field-addons-service";
import { payChoiceOf, pickAddOns, priceBooking, taxOf, withExtraMinutes } from "@/lib/server/field-booking-pricing";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import type { Job } from "@/types/field-services";
import type { Quote } from "@/types/quotes";
import type { Contact } from "@/types/contacts";
import { formatServiceAddress, sanitizeServiceAddress } from "@/lib/field-services/address";
import { deliverToContact, withStatusLink } from "@/lib/server/field-messages-service";
import { createJobFromRequest } from "@/lib/server/field-jobs-service";
import { checkServiceArea, createServiceRequest } from "@/lib/server/field-requests-service";
import { getFieldServicesConfig, getJobTerms } from "@/lib/server/field-services-config-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { createDealServerSide } from "@/lib/server/deals-service";
import { loadResolvedPipelines } from "@/lib/server/pipelines-service";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { minorToUnit, unitToMinor } from "@/lib/field-services/money";
import type { SubAccountDoc } from "@/types/tenancy";
import type { FieldServicesConfig, ServiceArea } from "@/types/field-services";

export const BOOKING_WINDOWS: Record<string, string> = {
  any: "Any time",
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

const ID = /^[A-Za-z0-9_-]{6,128}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_SERVICES = 10;
const DEFAULT_MAX_DAYS = 90;

export function maxDaysAhead(config: FieldServicesConfig): number {
  const n = config.bookingMaxDays;
  return n === 30 || n === 60 || n === 90 ? n : DEFAULT_MAX_DAYS;
}

export interface PublicBookingService {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  durationMinutes: number | null;
  /** Fewest hours of notice for an instant booking of this service. */
  minLeadHours: number;
  /** How many staff the service needs on site at once. */
  staffRequired: number;
  /** The service's own deposit percentage, or null to use the workspace's. */
  depositPercent: number | null;
  /** The deposit to pay online for this service, in minor units. Zero when none is taken. */
  depositMinor: number;
  category: string;
  color: string | null;
  imageUrl: string | null;
  /** Options the customer must choose between, each with its own time and price. */
  variants: { id: string; name: string; durationMinutes: number; priceMinor: number; depositMinor?: number }[];
  /** Set once an option has been applied. */
  variantId?: string;
}

/** The service as the picked option changes it: its name, time allowance and price. */
export function withVariant(service: PublicBookingService, variantId: unknown): PublicBookingService {
  if (service.variants.length === 0) return service;
  const v = service.variants.find((x) => x.id === variantId);
  if (!v) throw new FieldServicesError(`Choose an option for ${service.name}.`);
  return {
    ...service,
    name: `${service.name} (${v.name})`,
    priceMinor: v.priceMinor,
    durationMinutes: v.durationMinutes > 0 ? v.durationMinutes : service.durationMinutes,
    variantId: v.id,
  };
}

export interface PublicBookingConfig {
  businessName: string;
  intro: string;
  doneMessage: string;
  accent: string;
  theme: "light" | "dark" | "auto";
  /** Design direction for the page (see `booking-styles.ts`). */
  style: BookingStyleId;
  /** The workspace's client logo (Settings, Branding), or null. */
  logoUrl: string | null;
  /** Where customers can reach the business, from the account contact. */
  contact: { email: string | null; phone: string | null };
  askWhen: boolean;
  /** The footer's business details, or null when the footer is off. */
  footer: { name: string; address: string; phone: string; email: string; website: string } | null;
  /** Some bookable service takes a deposit by card. */
  depositOn: boolean;
  /** Cancellation and refund wording shown beside the deposit. */
  refundPolicy: string;
  /** Extras a customer can tick, active ones only. Empty serviceIds with allServices off never reaches here. */
  addOns: { id: string; name: string; priceMinor: number; extraMinutes: number; allServices: boolean; serviceIds: string[] }[];
  /** The workspace's tax, or null when it charges none. */
  tax: { name: string; percent: number; inclusive: boolean } | null;
  /** One service per booking. */
  singleService: boolean;
  /** The customer picks an open time and the booking is made straight away. */
  instant: boolean;
  /** Furthest day a customer may ask for, counted from today. */
  maxDaysAhead: number;
  blockOutOfArea: boolean;
  /** The customer portal is on, so the confirmation can link to it. */
  portalOpen: boolean;
  defaultCountry: string;
  /** On the website booking page: a way back to the site. */
  backLink: { url: string; label: string } | null;
  services: PublicBookingService[];
}

export async function loadSub(subAccountId: string): Promise<(SubAccountDoc & { id: string }) | null> {
  if (!ID.test(subAccountId)) return null;
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.exists ? ({ ...(snap.data() as SubAccountDoc), id: snap.id }) : null;
}

export function bookingOpen(sub: SubAccountDoc | null, config: FieldServicesConfig): boolean {
  return !!sub && fieldServicesAvailable(sub) && config.onlineBookingEnabled === true && config.requestIntake !== false;
}

export async function loadServices(subAccountId: string, ids: string[], config?: FieldServicesConfig): Promise<PublicBookingService[]> {
  const wanted = [...new Set(ids.filter((id) => ID.test(id)))].slice(0, 30);
  if (wanted.length === 0) return [];
  const db = getAdminDb();
  const categories = serviceCategoryList(config ?? (await getFieldServicesConfig(subAccountId)));
  const docs = await db.getAll(...wanted.map((id) => db.doc(`products/${id}`)));
  return docs
    .filter((d) => d.exists && d.data()?.subAccountId === subAccountId && d.data()?.kind === "service" && d.data()?.active !== false && d.data()?.billingType !== "time_and_materials")
    .map((d) => {
      const p = d.data() ?? {};
      return {
        id: d.id,
        name: String(p.name ?? "").slice(0, 120),
        description: String(p.description ?? "").slice(0, 600),
        priceMinor: Math.max(0, Math.round(Number(p.unitPriceCents) || 0)),
        currency: typeof p.currency === "string" && p.currency ? p.currency : "USD",
        durationMinutes: typeof p.durationMinutes === "number" && p.durationMinutes > 0 ? p.durationMinutes : null,
        minLeadHours:
          typeof p.minLeadHours === "number" && p.minLeadHours >= 0 ? Math.min(2_160, Math.round(p.minLeadHours)) : 2,
        staffRequired: typeof p.staffRequired === "number" && p.staffRequired >= 1 && p.staffRequired <= 5 ? Math.round(p.staffRequired) : 1,
        depositPercent: typeof p.depositPercent === "number" ? p.depositPercent : null,
        depositMinor: 0,
        variants: (Array.isArray(p.variants) ? p.variants : [])
          .slice(0, 8)
          .filter((v: unknown) => !!v && typeof (v as { id?: unknown }).id === "string" && typeof (v as { name?: unknown }).name === "string")
          .map((v: { id: string; name: string; durationMinutes?: unknown; unitPriceCents?: unknown }) => ({
            id: v.id,
            name: v.name.slice(0, 60),
            durationMinutes: typeof v.durationMinutes === "number" && v.durationMinutes > 0 ? Math.min(1_440, Math.round(v.durationMinutes)) : 0,
            priceMinor: Math.max(0, Math.round(Number(v.unitPriceCents) || 0)),
          })),
        category: serviceCategoryOf(categories, p.category),
        color: typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : null,
        imageUrl:
          Array.isArray(p.images) && typeof p.images[0]?.url === "string" && /^https:\/\//i.test(p.images[0].url)
            ? (p.images[0].url as string)
            : null,
      };
    })
    .sort((a, b) => wanted.indexOf(a.id) - wanted.indexOf(b.id));
}

/** The logo and theme both public pages share. Only an http(s) logo URL is ever used. */
export function publicLook(
  sub: SubAccountDoc,
  config: FieldServicesConfig,
): {
  theme: "light" | "dark" | "auto";
  style: BookingStyleId;
  logoUrl: string | null;
  contact: { email: string | null; phone: string | null };
} {
  const logo = typeof sub.logoUrl === "string" && /^https:\/\/.+/i.test(sub.logoUrl) ? sub.logoUrl : null;
  const theme = config.bookingTheme === "dark" || config.bookingTheme === "auto" ? config.bookingTheme : "light";
  const c = sub.accountContact;
  return {
    theme,
    style: bookingStyleOf(config.bookingStyle).id,
    logoUrl: logo,
    contact: {
      email: typeof c?.email === "string" && c.email ? c.email : null,
      phone: typeof c?.phone === "string" && c.phone ? c.phone : null,
    },
  };
}

/** The footer lines the workspace chose to show, from its business details with the account contact as a fallback. */
function footerFor(sub: SubAccountDoc, config: FieldServicesConfig) {
  if (config.bookingFooterEnabled === false) return null;
  const show = new Set(config.bookingFooterFields ?? ["name", "address", "phone", "email", "website"]);
  const b = sub.businessDetails;
  const c = sub.accountContact;
  return {
    name: show.has("name") ? b?.name || sub.name || "" : "",
    address: show.has("address") ? formatServiceAddress(b?.address) : "",
    phone: show.has("phone") ? b?.phone || c?.phone || "" : "",
    email: show.has("email") ? b?.email || c?.email || "" : "",
    website: show.has("website") ? b?.website || "" : "",
  };
}

/** What the public page may show. Null when online booking is off, so the page can't be used to probe a workspace. */
export async function loadPublicBookingConfig(
  subAccountId: string,
  variant: "standard" | "site" = "standard",
): Promise<PublicBookingConfig | null> {
  const sub = await loadSub(subAccountId);
  if (!sub) return null;
  const config = await getFieldServicesConfig(subAccountId);
  if (!bookingOpen(sub, config)) return null;
  // The website's page exists only once a site build has made it.
  const site = variant === "site" ? config.siteBooking ?? null : null;
  if (variant === "site" && !site) return null;
  const loaded = await loadServices(subAccountId, config.bookingServiceIds ?? [], config);
  if (loaded.length === 0) return null;
  const services = loaded.map((sv) => ({
    ...sv,
    depositMinor: depositMinorFor({ sub, config, priceMinor: sv.priceMinor, currency: sv.currency, servicePercent: sv.depositPercent }),
    variants: sv.variants.map((v) => ({
      ...v,
      depositMinor: depositMinorFor({ sub, config, priceMinor: v.priceMinor, currency: sv.currency, servicePercent: sv.depositPercent }),
    })),
  }));
  const addOns = (await loadBookableAddOns(subAccountId, loaded.map((sv) => sv.id))).map((a) => ({
    id: a.id,
    name: a.name,
    priceMinor: a.priceMinor,
    extraMinutes: a.extraMinutes,
    allServices: a.allServices,
    serviceIds: a.serviceIds,
  }));
  return {
    addOns,
    tax: taxOf(config),
    footer: footerFor(sub, config),
    depositOn: services.some((sv) => sv.depositMinor > 0),
    refundPolicy: config.bookingRefundPolicy ?? "",
    businessName: sub.name || "Book a service",
    intro: config.bookingIntro ?? "",
    doneMessage: config.bookingDoneMessage ?? "",
    accent: site ? site.accent : config.bookingAccent ?? "",
    ...publicLook(sub, config),
    ...(site ? { theme: site.theme, style: bookingStyleOf(site.style).id } : {}),
    backLink: site?.siteUrl && /^https:\/\//i.test(site.siteUrl) ? { url: site.siteUrl, label: "Back to our website" } : null,
    askWhen: config.bookingAskWhen !== false,
    singleService: config.bookingInstant === true || config.bookingSingleService === true,
    instant: config.bookingInstant === true,
    maxDaysAhead: maxDaysAhead(config),
    blockOutOfArea: config.outOfAreaPolicy === "block",
    portalOpen: config.customerPortalEnabled === true,
    defaultCountry: workspaceCountry(sub),
    services,
  };
}

/** What the customer would pay for a selection, worked out the same way the booking itself is. */
export async function quoteBooking(subAccountId: string, body: Record<string, unknown>) {
  if (!ID.test(subAccountId)) throw new FieldServicesError("Online booking isn't available.", 404);
  const sub = await loadSub(subAccountId);
  if (!sub) throw new FieldServicesError("Online booking isn't available.", 404);
  const config = await getFieldServicesConfig(subAccountId);
  if (!bookingOpen(sub, config)) throw new FieldServicesError("Online booking isn't available.", 404);
  const serviceIds = Array.isArray(body.services)
    ? [...new Set(body.services.filter((s): s is string => typeof s === "string"))].slice(0, MAX_SERVICES)
    : [];
  const offered = await loadServices(subAccountId, config.bookingServiceIds ?? [], config);
  const picks = (body.variants && typeof body.variants === "object" ? body.variants : {}) as Record<string, unknown>;
  const chosen = offered.filter((s) => serviceIds.includes(s.id)).map((s) => withVariant(s, picks[s.id]));
  if (chosen.length === 0 || chosen.length !== serviceIds.length) throw new FieldServicesError("Choose at least one service from the list.");
  if (new Set(chosen.map((s) => s.currency)).size > 1) throw new FieldServicesError("Those services are priced in different currencies. Book them separately.");
  const addOns = await pickAddOns(subAccountId, chosen.map((s) => s.id), body.addOnIds);
  const priced = priceBooking({ sub, config, services: chosen, addOns });
  return {
    currency: priced.currency,
    lines: priced.lines,
    netMinor: priced.netMinor,
    taxMinor: priced.taxMinor,
    totalMinor: priced.totalMinor,
    tax: priced.tax,
    depositMinor: priced.depositMinor,
    options: priced.options,
    extraMinutes: priced.extraMinutes,
  };
}

export interface AreaAnswer {
  status: "in_area" | "out_of_area" | "unknown";
  travelFeeMinor: number | null;
  /** Blocked by the workspace's out-of-area policy. */
  blocked: boolean;
}

/** In or out of the service areas, and the travel fee. Never names an area. */
export async function checkBookingArea(
  subAccountId: string,
  countryRaw: unknown,
  postcodeRaw: unknown,
  extra: { line1?: unknown; city?: unknown; region?: unknown } = {},
): Promise<AreaAnswer> {
  const sub = await loadSub(subAccountId);
  if (!sub) throw new FieldServicesError("Online booking isn't available.", 404);
  const config = await getFieldServicesConfig(subAccountId);
  if (!bookingOpen(sub, config)) throw new FieldServicesError("Online booking isn't available.", 404);
  const postcode = typeof postcodeRaw === "string" ? postcodeRaw.trim().slice(0, 12) : "";
  if (!postcode) throw new FieldServicesError("Enter the postcode.");
  const country = cleanCountry(countryRaw, workspaceCountry(sub));
  const areasSnap = await getAdminDb().collection(`subAccounts/${subAccountId}/serviceAreas`).get();
  const areas = areasSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as ServiceArea);
  const match = await matchAreasForAddress(areas, {
    line1: text(extra.line1, 200),
    city: text(extra.city, 100),
    region: text(extra.region, 100),
    postcode,
    country,
  });
  if (match.status === "in_area") {
    return { status: "in_area", travelFeeMinor: match.area.travelFeeCents ?? null, blocked: false };
  }
  if (match.status === "out_of_area") {
    return { status: "out_of_area", travelFeeMinor: null, blocked: config.outOfAreaPolicy === "block" };
  }
  return { status: "unknown", travelFeeMinor: null, blocked: false };
}

/** The address as the contact card shows it: street, city, state and postcode, then the country name. */
function contactAddressText(a: { line1: string; line2?: string; city: string; region: string; postcode: string; country: string }): string {
  let country = "";
  try {
    country = new Intl.DisplayNames(["en"], { type: "region" }).of(a.country) ?? "";
  } catch {
    country = "";
  }
  return [formatServiceAddress(a), country].filter(Boolean).join(", ");
}

/** A two-letter country code. UK is accepted for GB, and anything else falls back to the workspace default. */
/** Where the business is: its saved address, then the phone country, then the US. */
function workspaceCountry(sub: SubAccountDoc): string {
  return cleanCountry(sub.businessDetails?.address?.country, sub.defaultPhoneCountry || "US");
}

export function cleanCountry(raw: unknown, fallback: string): string {
  const c = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (c === "UK") return "GB";
  return /^[A-Z]{2}$/.test(c) ? c : fallback;
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export interface BookingResult {
  number: string;
  statusUrl: string | null;
  /** Set when the booking took a time straight away, such as Tue 3 Nov, 2:30 pm. */
  scheduledLabel?: string | null;
  /** Set when a deposit is due: the customer pays it with this link's token to confirm the booking. */
  depositToken?: string | null;
  /** The deposit due, in minor units. */
  depositMinor?: number;
}

/** Turns a booking page submission into a contact, a request and a job waiting to be scheduled. */
export async function submitBookingRequest(
  subAccountId: string,
  body: Record<string, unknown>,
): Promise<BookingResult> {
  const clientId = typeof body.clientId === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(body.clientId) ? body.clientId : null;
  const holder: { release?: () => Promise<void> } = {};
  if (!clientId || !ID.test(subAccountId)) {
    try {
      return await submitOnce(subAccountId, body, holder);
    } finally {
      await holder.release?.();
    }
  }
  const claim = getAdminDb().doc(`fieldBookingSubmissions/${subAccountId}_${clientId}`);
  try {
    await claim.create({ startedAt: Date.now(), expiresAtMs: Date.now() + 86_400_000 });
  } catch {
    const prior = (await claim.get()).data();
    if (prior?.number !== undefined) {
      return {
        number: String(prior.number),
        statusUrl: (prior.statusUrl as string | null) ?? null,
        scheduledLabel: (prior.scheduledLabel as string | null) ?? null,
        depositToken: (prior.depositToken as string | null) ?? null,
        depositMinor: typeof prior.depositMinor === "number" ? prior.depositMinor : 0,
      };
    }
    // A send that never finished does not block a retry for long.
    if (typeof prior?.startedAt !== "number" || Date.now() - prior.startedAt < 60_000) {
      throw new FieldServicesError("Your request is already being sent. Give it a moment.", 409);
    }
    await claim.set({ startedAt: Date.now(), expiresAtMs: Date.now() + 86_400_000 });
  }
  try {
    const res = await submitOnce(subAccountId, body, holder);
    await claim.update({ number: res.number, statusUrl: res.statusUrl, scheduledLabel: res.scheduledLabel ?? null, depositToken: res.depositToken ?? null, depositMinor: res.depositMinor ?? 0 }).catch(() => {});
    return res;
  } catch (err) {
    // Not sent, so the customer can fix it and try again.
    await claim.delete().catch(() => {});
    throw err;
  } finally {
    await holder.release?.();
  }
}

async function submitOnce(
  subAccountId: string,
  body: Record<string, unknown>,
  holder: { release?: (() => Promise<void>) | undefined } = {},
): Promise<BookingResult> {
  const sub = await loadSub(subAccountId);
  if (!sub) throw new FieldServicesError("Online booking isn't available.", 404);
  const config = await getFieldServicesConfig(subAccountId);
  if (!bookingOpen(sub, config)) throw new FieldServicesError("Online booking isn't available.", 404);
  const terms = await getJobTerms(subAccountId);

  const name = text(body.name, 100);
  const email = text(body.email, 200).toLowerCase();
  const phone = text(body.phone, 30);
  const notes = text(body.notes, 1_000);
  if (!name) throw new FieldServicesError("Enter your name.");
  if (!EMAIL.test(email)) throw new FieldServicesError("Enter a valid email address.");

  const serviceIds = Array.isArray(body.services)
    ? [...new Set(body.services.filter((s): s is string => typeof s === "string"))].slice(0, MAX_SERVICES)
    : [];
  const offered = await loadServices(subAccountId, config.bookingServiceIds ?? [], config);
  const picks = (body.variants && typeof body.variants === "object" ? body.variants : {}) as Record<string, unknown>;
  const chosen = offered.filter((s) => serviceIds.includes(s.id)).map((s) => withVariant(s, picks[s.id]));
  if (chosen.length === 0 || chosen.length !== serviceIds.length) {
    throw new FieldServicesError("Choose at least one service from the list.");
  }
  const instant = config.bookingInstant === true;
  if ((instant || config.bookingSingleService === true) && chosen.length !== 1) {
    throw new FieldServicesError("Choose one service.");
  }
  if (new Set(chosen.map((s) => s.currency)).size > 1) {
    throw new FieldServicesError("Those services are priced in different currencies. Book them separately.");
  }

  const addOns = await pickAddOns(subAccountId, chosen.map((s) => s.id), body.addOnIds);
  const priced = priceBooking({ sub, config, services: chosen, addOns });
  const payChoice = payChoiceOf(priced.options, body.payChoice);
  // Open times and the visit length allow for the extras' time.
  const slotService = withExtraMinutes(chosen[0], priced.extraMinutes);

  const a = (body.address && typeof body.address === "object" ? body.address : {}) as Record<string, unknown>;
  const address = sanitizeServiceAddress({
    line1: text(a.line1, 200),
    city: text(a.city, 100),
    region: text(a.state, 100),
    postcode: text(a.postcode, 12),
    country: cleanCountry(a.country, workspaceCountry(sub)),
  });
  if (!address || !address.line1 || !address.postcode) throw new FieldServicesError("Enter the street address and postcode.");

  let when = "";
  if (!instant && config.bookingAskWhen !== false && body.date) {
    const tzRaw = sub.timezone;
    const tz = typeof tzRaw === "string" && tzRaw ? tzRaw : "UTC";
    const today = zonedDateKey(new Date(), tz);
    // A day of slack, because the customer picked it in their own time zone.
    if (!isDayKey(body.date) || body.date < addDaysToKey(today, -1) || body.date > addDaysToKey(today, maxDaysAhead(config) + 1)) {
      throw new FieldServicesError("Choose a date from today onwards.");
    }
    const win = typeof body.window === "string" && Object.hasOwn(BOOKING_WINDOWS, body.window) ? body.window : "any";
    when = `${body.date} (${BOOKING_WINDOWS[win].toLowerCase()})`;
  }

  // Refuses an address the workspace blocks before anything is created.
  await checkServiceArea(subAccountId, address);

  // The time is held for the least busy person who is free, before anything is created.
  const held = instant ? await claimBookingSlot(subAccountId, slotService, address, body.slot) : null;
  if (held) {
    when = held.label;
    holder.release = held.release;
  }

  let contact: Awaited<ReturnType<typeof reconcileBookingContact>>;
  try {
    contact = await reconcileBookingContact({
    agencyId: sub.agencyId,
    subAccountId,
    email,
    name,
    phone,
    phoneCountry: (sub.defaultPhoneCountry as string | null | undefined) ?? null,
    fillMissing: false,
    address: contactAddressText(address),
    city: address.city,
    countryCode: address.country,
  });
  } catch (err) {
    await held?.release();
    throw err;
  }
  if (contact.created) {
    const consented = body.consent !== false;
    // A declined box is our own block, not a carrier STOP, so it can be lifted if they agree later.
    await getAdminDb()
      .doc(`contacts/${contact.id}`)
      .update({
        smsConsent: {
          consented,
          textShown: "It's OK to text me about this request.",
          consentedAt: consented ? FieldValue.serverTimestamp() : null,
          sourceUrl: null,
          ip: null,
        },
      })
      .catch(() => {});
  }

  const title = chosen.length === 1 ? chosen[0].name : `${chosen[0].name} + ${chosen.length - 1} more`;
  const description = [
    "Online booking request.",
    `Services: ${chosen.map((s) => s.name).join(", ")}`,
    addOns.length ? `Extras: ${addOns.map((a) => a.name).join(", ")}` : "",
    payChoice === "in_person" ? "The customer will pay in person." : "",
    when ? (held ? `Booked time: ${when}` : `Preferred date: ${when}`) : "",
    notes ? `Customer notes: ${notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const request = await createServiceRequest({
    agencyId: sub.agencyId,
    subAccountId,
    createdByUid: "booking-page",
    contactId: contact.id,
    title,
    description,
    serviceAddress: address,
    serviceIds: chosen.map((s) => s.id),
    source: "booking",
    autoConvert: false,
    // Anyone can type a customer's email, so only a contact made by this request keeps the address.
    saveAddress: contact.created,
  });

  // Optional: the booking also shows up on the pipeline board. A failure here never loses the booking.
  let dealId: string | null = null;
  if (config.bookingCreateDeal === true) {
    try {
      const total = priced.totalMinor;
      const pipelines = await loadResolvedPipelines(subAccountId);
      const wanted = pipelines.find((p) => p.id === (config.bookingDealPipelineId || "default"));
      const wantedStage = wanted?.stages.find((st) => st.id === config.bookingDealStageId && !st.terminal);
      // A pipeline or stage deleted since it was chosen must not stop deals being made.
      const target = wanted && wantedStage ? { pipeline: wanted, stage: wantedStage } : null;
      const fallback = pipelines.find((p) => p.id === "default") ?? pipelines[0];
      const pipeline = target?.pipeline ?? fallback;
      const stage = target?.stage ?? pipeline?.stages.find((st) => !st.terminal);
      if (!pipeline || !stage) throw new Error("no open pipeline stage");
      const contactDoc = (await getAdminDb().doc(`contacts/${contact.id}`).get()).data();
      const deal = await createDealServerSide({
        subAccountId,
        agencyId: sub.agencyId,
        createdByUid: "booking-page",
        mode: "live",
        title,
        value: minorToUnit(chosen[0].currency, total),
        currency: chosen[0].currency,
        contactId: contact.id,
        pipelineId: pipeline.id,
        stageId: stage.id,
        priority: "medium",
        territoryId: typeof contactDoc?.territoryId === "string" ? contactDoc.territoryId : null,
      });
      dealId = deal.id;
      // The job made from the request carries the deal too.
      await getAdminDb().doc(`serviceRequests/${request.id}`).update({ dealId });
    } catch (err) {
      console.warn("[field-booking] adding the deal to the pipeline failed", err);
    }
  }


  let jobId: string | null = null;
  let assignedTo: string | null = null;
  let picked: { id: string; start: string; minutes: number; label: string } | null = null;
  let version = 1;
  try {
    const job = await createJobFromRequest({
      agencyId: sub.agencyId,
      subAccountId,
      createdByUid: "booking-page",
      requestId: request.id,
      currency: chosen[0].currency,
      // The rate this booking was made at stays with the job, whatever the workspace sets later.
      tax: priced.tax,
      lineItems: [
        ...chosen.map((s, i) => {
          // The extras' time rides on the first service's line, which is what the visit length is read from.
          const minutes = i === 0 ? slotService.durationMinutes : s.durationMinutes;
          const stretched = i === 0 && priced.extraMinutes > 0;
          return {
            id: `s_${s.id}`.slice(0, 64),
            description: s.name,
            quantity: 1,
            unitPriceMinor: s.priceMinor,
            productId: s.id,
            ...((s.variantId || stretched) && minutes ? { ...(s.variantId ? { variantId: s.variantId } : {}), durationMinutes: minutes } : {}),
          };
        }),
        ...addOns.map((a) => ({
          id: `a_${a.id}`.slice(0, 64),
          description: a.name,
          quantity: 1,
          unitPriceMinor: a.priceMinor,
        })),
      ],
    });
    jobId = job.id;
    // One service and no booked time: give it to the best-fitting person now. Instant bookings already have one.
    if (!held && chosen.length === 1 && chosen[0].staffRequired <= 1) {
      try {
        const win = typeof body.window === "string" ? body.window : "any";
        const day = config.bookingAskWhen !== false && isDayKey(body.date) ? body.date : null;
        const pick = await pickStaffForBooking(subAccountId, slotService, address, day, win);
        if (pick) {
          await getAdminDb().doc(`jobs/${job.id}`).update({ workerIds: [pick.id] });
          assignedTo = pick.name;
          picked = pick;
        }
      } catch (err) {
        console.warn("[field-booking] choosing staff failed, left unassigned", err);
      }
    }
    const jobDoc = (await getAdminDb().doc(`jobs/${job.id}`).get()).data();
    version = typeof jobDoc?.statusTokenVersion === "number" ? jobDoc.statusTokenVersion : 1;
  } catch (err) {
    console.warn("[field-booking] turning the request into a job failed", err);
  }

  // The booked time becomes a visit for that person, which tells them and the customer.
  // A deposit by card holds the time until it is paid. The visit is made, and everyone told, only after that.
  const depositMinor = !jobId ? 0 : payChoice === "full" ? priced.totalMinor : payChoice === "deposit" ? priced.depositMinor : 0;
  const allowText = body.consent !== false && contact.created;
  let depositToken: string | null = null;
  let depositFailed = false;
  if (jobId && depositMinor > 0) {
    try {
      const jobDoc = (await getAdminDb().doc(`jobs/${jobId}`).get()).data() as Job | undefined;
      if (!jobDoc) throw new Error("job missing");
      await held?.extend(Date.now() + DEPOSIT_HOLD_MS + 120_000);
      const made = await createDepositInvoice({
        sub,
        job: { ...jobDoc, id: jobId },
        hold: held
          ? {
              workerId: held.workerId,
              workerIds: held.workerIds,
              extra: held.extra,
              startMs: held.start.getTime(),
              endMs: held.end.getTime(),
              label: held.label,
              docPath: held.docPath,
              token: held.token,
            }
          : null,
        allowText,
        amountMinor: depositMinor,
        serviceName: title,
        policy: config.bookingRefundPolicy ?? "",
        full: payChoice === "full",
      });
      depositToken = made.token;
      // The hold now belongs to the deposit invoice, so the wrapper must not give it back.
      holder.release = undefined;
    } catch (err) {
      // No deposit invoice means no way to pay, so the booking goes ahead without one.
      console.warn("[field-booking] making the deposit invoice failed", err);
      depositFailed = true;
    }
  }

  let scheduledLabel: string | null = null;
  if (!depositToken) {
    // The booked time becomes a visit for that person, which tells them and the customer.
    if (held && jobId) {
      try {
        await createVisit({
          agencyId: sub.agencyId,
          subAccountId,
          createdByUid: "booking-page",
          jobId,
          scheduledStart: held.start.toISOString(),
          scheduledEnd: held.end.toISOString(),
          workerIds: held.workerIds,
          notes: "System scheduled",
        });
        scheduledLabel = held.label;
      } catch (err) {
        console.warn("[field-booking] making the visit failed, left as a request", err);
      }
    }
    await held?.release();

    // No time was held, so the person chosen gets their next open stretch (their visit alerts the customer too).
    if (!held && picked && jobId) {
      try {
        await createVisit({
          agencyId: sub.agencyId,
          subAccountId,
          createdByUid: "booking-page",
          jobId,
          scheduledStart: picked.start,
          durationMinutes: picked.minutes,
          workerIds: [picked.id],
          autoScheduled: true,
          notes: "System scheduled",
        });
        scheduledLabel = picked.label;
      } catch (err) {
        console.warn("[field-booking] scheduling the chosen person failed, left unscheduled", err);
      }
    }

    await sendConfirmation({
      sub,
      config,
      contactId: contact.id,
      title,
      bookedLabel: scheduledLabel,
      jobId,
      version,
      subAccountId,
      // A matched contact may not be the person typing, so they are emailed rather than texted.
      allowText,
    });
    await createTaskServerSide({
      subAccountId,
      agencyId: sub.agencyId,
      createdByUid: "booking-page",
      mode: "live",
      title: `New online booking request from ${name}`,
      notes: `${title}${when ? `, ${scheduledLabel ? "booked for" : "preferred"} ${when}` : ""}. ${
        scheduledLabel
          ? "The visit is already in the schedule."
          : jobId
          ? `It is in the ${terms.jobs} list waiting to be scheduled${assignedTo ? `, with ${assignedTo} assigned` : ""}.`
          : `It could not become ${withArticle(terms.job)} automatically, so it is waiting on the Requests tab.`
      }${depositFailed ? ` The ${payChoice === "full" ? "payment" : "deposit"} could not be set up, so none was taken.` : ""}`,
      dueAt: null,
      contactId: contact.id,
      dealId,
      eventId: null,
    }).catch((err) => console.warn("[field-booking] office task failed", err));
  } else {
    // Shown to the customer while the time is held.
    scheduledLabel = held?.label ?? null;
  }

  return {
    number: request.number,
    statusUrl: jobId ? jobStatusUrl(jobId, version) : null,
    scheduledLabel,
    depositToken,
    depositMinor: depositToken ? depositMinor : 0,
  };
}

/** Runs when a booking's deposit is paid: the visit is made for the held time and the customer is told. */
export async function confirmDepositBooking(quoteId: string): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`quotes/${quoteId}`);
  // Acts once, however many times the payment event arrives.
  const quote = await db.runTransaction(async (tx) => {
    const q = (await tx.get(ref)).data() as Quote | undefined;
    if (!q?.fieldDeposit || q.fieldDeposit.confirmedAtMs) return null;
    tx.update(ref, { "fieldDeposit.confirmedAtMs": Date.now() });
    return q;
  });
  const fd = quote?.fieldDeposit;
  if (!quote || !fd) return;
  const jobSnap = await db.doc(`jobs/${fd.jobId}`).get();
  // The stored doc has no id field, and createVisit and the messages below need it.
  const job = jobSnap.exists ? ({ id: jobSnap.id, ...jobSnap.data() } as Job) : undefined;
  if (!job || job.subAccountId !== quote.subAccountId) return;
  const sub = await loadSub(quote.subAccountId);
  if (!sub) return;
  const config = await getFieldServicesConfig(quote.subAccountId);
  const task = (title: string, notes: string) =>
    createTaskServerSide({
      subAccountId: quote.subAccountId,
      agencyId: quote.agencyId,
      createdByUid: "booking-page",
      mode: "live",
      title,
      notes,
      dueAt: null,
      contactId: job.contactId,
      dealId: job.dealId ?? null,
      eventId: null,
    }).catch((err) => console.warn("[field-booking] deposit task failed", err));

  await jobSnap.ref.update({
    depositPaidMinor: unitToMinor(job.currency, computeQuoteTotals(quote).total),
    updatedAt: FieldValue.serverTimestamp(),
  });

  let bookedLabel: string | null = null;
  let lapsed = fd.instant && job.status === "cancelled";
  if (fd.instant && fd.hold && !lapsed) {
    const hold = fd.hold;
    try {
      const start = new Date(hold.startMs);
      const end = new Date(hold.endMs);
      const travel = Math.max(
        0,
        ...(await Promise.all(job.lineItems.filter((l) => l.productId).map((l) => serviceTravelMinutes(l.productId as string)))),
      );
      const clash = await findScheduleClashes({
        subAccountId: quote.subAccountId,
        workerIds: hold.workerIds ?? [hold.workerId],
        start,
        end,
        travelMinutes: travel,
      });
      if (clash.overlap.length > 0 || clash.tight.length > 0) {
        lapsed = true;
      } else {
        await createVisit({
          agencyId: quote.agencyId,
          subAccountId: quote.subAccountId,
          createdByUid: "booking-page",
          jobId: job.id,
          scheduledStart: start.toISOString(),
          scheduledEnd: end.toISOString(),
          workerIds: hold.workerIds ?? [hold.workerId],
          notes: "System scheduled",
        });
        bookedLabel = hold.label;
      }
    } catch (err) {
      console.warn("[field-booking] making the visit after the deposit failed", err);
      lapsed = true;
    }
    await releaseHold(hold);
  }
  if (lapsed) {
    // The money is taken but the time could not be kept.
    await task(
      `Deposit paid but the booking could not be kept (${job.number})`,
      `${job.title}. The customer paid invoice ${quote.quoteNumber}, but their time was no longer free. Refund the deposit in Stripe or rebook them. They have been told you will be in touch.`,
    );
    // The customer has paid, so they hear about it now instead of waiting on the office.
    await sendTimeLostNotice({ sub, contactId: job.contactId, title: job.title, jobId: job.id, allowText: fd.allowText });
    return;
  }

  const version = typeof job.statusTokenVersion === "number" ? job.statusTokenVersion : 1;
  await sendConfirmation({
    sub,
    config,
    contactId: job.contactId,
    title: job.title,
    bookedLabel,
    jobId: job.id,
    version,
    subAccountId: quote.subAccountId,
    allowText: fd.allowText,
  }).catch((err) => console.warn("[field-booking] deposit confirmation failed", err));
  await task(
    `Deposit paid for ${job.number}`,
    `${job.title}. The deposit invoice ${quote.quoteNumber} is paid${bookedLabel ? `, booked for ${bookedLabel}` : ""}.`,
  );
}

async function sendConfirmation(input: {
  sub: SubAccountDoc & { id: string };
  config: FieldServicesConfig;
  contactId: string;
  title: string;
  bookedLabel?: string | null;
  jobId: string | null;
  version: number;
  subAccountId: string;
  allowText: boolean;
}): Promise<void> {
  try {
    const snap = await getAdminDb().doc(`contacts/${input.contactId}`).get();
    if (!snap.exists) return;
    const stored = { id: snap.id, ...snap.data() } as Contact;
    // Without the text box ticked the message goes by email only.
    const contact = input.allowText ? stored : { ...stored, phone: "" };
    const first = (contact.name || "").split(/\s+/)[0].replace(/[^\p{L}'-]/gu, "").slice(0, 30) || "there";
    const extra = input.config.bookingDoneMessage ? ` ${input.config.bookingDoneMessage}` : "";
    let body = input.bookedLabel
      ? `Hi ${first}, you're booked for "${input.title}" on ${input.bookedLabel}.${extra}`
      : `Hi ${first}, thanks for your request for "${input.title}". We'll confirm a time with you soon.${extra}`;
    if (input.jobId) body = withStatusLink(body, input.config, input.jobId, input.version);
    await deliverToContact({
      sub: input.sub,
      contact,
      body,
      subject: `${input.sub.name || "Your request"}: we received your request`,
      agencyId: input.sub.agencyId,
      subAccountId: input.subAccountId,
      label: "Booking confirmation",
      meta: input.jobId ? { jobId: input.jobId } : {},
    });
  } catch (err) {
    console.warn("[field-booking] confirmation failed", err);
  }
}

/** Tells a customer who paid a deposit that their time could not be kept. Never throws. */
async function sendTimeLostNotice(input: {
  sub: SubAccountDoc & { id: string };
  contactId: string;
  title: string;
  jobId: string;
  allowText: boolean;
}): Promise<void> {
  try {
    const snap = await getAdminDb().doc(`contacts/${input.contactId}`).get();
    if (!snap.exists) return;
    const stored = { id: snap.id, ...snap.data() } as Contact;
    const contact = input.allowText ? stored : { ...stored, phone: "" };
    const first = (contact.name || "").split(/\s+/)[0].replace(/[^\p{L}'-]/gu, "").slice(0, 30) || "there";
    await deliverToContact({
      sub: input.sub,
      contact,
      body: `Hi ${first}, we received your deposit for "${input.title}", but the time you chose is no longer available. We'll be in touch to rebook you or refund the deposit.`,
      subject: `${input.sub.name || "Your booking"}: about your booking`,
      agencyId: input.sub.agencyId,
      subAccountId: input.sub.id,
      label: "Booking could not be kept",
      meta: { jobId: input.jobId },
    });
  } catch (err) {
    console.warn("[field-booking] time lost notice failed", err);
  }
}
