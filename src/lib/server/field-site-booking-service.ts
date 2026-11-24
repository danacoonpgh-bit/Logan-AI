import "server-only";

import { fieldServicesAvailable } from "@/lib/field-services/availability";
import { getAdminDb } from "@/lib/firebase/admin";
import { loadServices } from "@/lib/server/field-booking-service";
import { fieldServicesConfigRef, getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import type { SubAccountDoc } from "@/types/tenancy";
import { BOOKING_STYLES, styleForConcept, type BookingStyleId } from "@/lib/field-services/booking-styles";
import type { SiteBooking } from "@/types/field-services";
import type { WebsiteConfig } from "@/types/website";

/** The booking page styled for a website. A separate address, so the standard page is never restyled. */
export function siteBookingUrl(appUrl: string, subAccountId: string): string {
  return `${appUrl.replace(/\/$/, "")}/book-service/${subAccountId}/site`;
}

/** Whether this workspace has a live booking page a site can point at. */
export async function siteBookingAvailable(subAccountId: string): Promise<boolean> {
  const sub = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() as SubAccountDoc | undefined;
  if (!sub || !fieldServicesAvailable(sub)) return false;
  const config = await getFieldServicesConfig(subAccountId);
  if (config.onlineBookingEnabled !== true || config.requestIntake === false) return false;
  return (await loadServices(subAccountId, config.bookingServiceIds ?? [], config)).length > 0;
}

/** A custom hex colour from the site's brief is the only colour known for certain. */
function looksFrom(
  config: WebsiteConfig,
  fallbackAccent: string,
): { accent: string; theme: "light" | "dark"; style: BookingStyleId } {
  const custom = config.design_color_palette === "Custom" ? config.custom_colors.match(/#[0-9a-fA-F]{6}/)?.[0] : null;
  // A site built from a design direction gets the matching booking style and that direction's own colour.
  // No pick means the builder's default for the niche, which for Home Services is Dispatch.
  const style = styleForConcept(config.concept ?? (config.niche === "home_services" ? "home_dispatch" : null));
  const own = style === "default" ? fallbackAccent : BOOKING_STYLES[style].accent;
  return {
    accent: (custom ?? own).toLowerCase(),
    theme: config.color_scheme === "Dark Mode" ? "dark" : "light",
    style,
  };
}

/** Creates or refreshes the website booking page record when a build starts. Never throws. */
export async function registerSiteBooking(input: {
  subAccountId: string;
  siteId: string;
  siteName: string;
  config: WebsiteConfig;
}): Promise<void> {
  try {
    const current = await getFieldServicesConfig(input.subAccountId);
    const existing = current.siteBooking ?? null;
    const derived = looksFrom(input.config, current.bookingAccent || "#2563eb");
    const kept = existing?.lookEdited === true ? existing : null;
    const next: SiteBooking = {
      websiteId: input.siteId,
      websiteName: input.siteName,
      siteUrl: existing?.websiteId === input.siteId ? existing.siteUrl : null,
      accent: kept?.accent ?? derived.accent,
      theme: kept?.theme ?? derived.theme,
      style: kept ? kept.style ?? "default" : derived.style,
      lookEdited: kept !== null,
    };
    await fieldServicesConfigRef(input.subAccountId).set({ siteBooking: next }, { merge: true });
  } catch (err) {
    console.warn(`[site-booking] could not save sa=${input.subAccountId}`, err);
  }
}

/** Stores the site's live address once it publishes, for the back link. Never throws. */
export async function setSiteBookingUrl(subAccountId: string, siteId: string, liveUrl: string | null): Promise<void> {
  try {
    const current = await getFieldServicesConfig(subAccountId);
    if (!current.siteBooking || current.siteBooking.websiteId !== siteId) return;
    await fieldServicesConfigRef(subAccountId).set({ siteBooking: { ...current.siteBooking, siteUrl: liveUrl } }, { merge: true });
  } catch (err) {
    console.warn(`[site-booking] could not save the site address sa=${subAccountId}`, err);
  }
}

/** The brief note that asks for a menu item. The builder writes the site, so this is a request, not a guarantee. */
export function menuNote(url: string): string {
  return `Add a "Book online" item to the main menu linking to ${url}. Every button that books or requests a service must link to ${url}.`;
}
