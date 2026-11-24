import "server-only";
import { isBookingStyleId } from "@/lib/field-services/booking-styles";
import { cleanServiceCategories } from "@/lib/field-services/service-categories";
import { routeReadiness } from "@/lib/server/field-route-service";

import { cleanTimeKinds } from "@/lib/field-services/time-kinds";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { applyWorkspaceCurrency } from "@/lib/server/field-currency-service";
import { loadResolvedPipelines } from "@/lib/server/pipelines-service";
import { BUTTON_COLOR_IDS } from "@/lib/field-services/button-colors";
import { cleanJobWord, DEFAULT_JOB_WORD, DEFAULT_JOB_WORD_PLURAL, DEFAULT_LABOUR_WORD, DEFAULT_ACTIVITY_WORD, jobTerms, type JobTerms, DEFAULT_WORKER_WORD, DEFAULT_WORKER_WORD_PLURAL } from "@/lib/field-services/terms";
import {
  DEFAULT_FIELD_SERVICES_CONFIG,
  SELECTABLE_BILLING_TYPES,
  type FieldServicesConfig,
} from "@/types/field-services";

function configRef(subAccountId: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}/fieldServicesConfig/main`);
}

export async function getFieldServicesConfig(
  subAccountId: string,
): Promise<FieldServicesConfig> {
  const snap = await configRef(subAccountId).get();
  return { ...DEFAULT_FIELD_SERVICES_CONFIG, ...(snap.data() ?? {}) };
}

/** The workspace's word for a job. Never throws, so error paths can use it freely. */
export async function getJobTerms(subAccountId: string): Promise<JobTerms> {
  try {
    return jobTerms(await getFieldServicesConfig(subAccountId));
  } catch {
    return jobTerms(null);
  }
}

const BOOLEAN_KEYS = [
  "requestIntake",
  "timerStopOnComplete",
  "reviewRequestsEnabled",
  "reviewWaitsForPayment",
  "notifyScheduled",
  "notifyReminder",
  "notifyOnMyWay",
  "notifyCompleted",
  "statusLinkInMessages",
  "setupGuideEnabled",
  "guidedSetupStarted",
  "guidedSetupStaffDone",
  "guidedSetupBookingDone",
  "guidedSetupSkipped",
  "dayClockEnabled",
  "use24HourTime",
  "timesheetsEnabled",
  "onlineBookingEnabled",
  "bookingAskWhen",
  "bookingSingleService",
  "bookingInstant",
  "bookingDepositEnabled",
  "bookingPayInFull",
  "bookingPayInPerson",
  "pricesIncludeTax",
  "bookingFooterEnabled",
  "bookingCreateDeal",
  "customerPortalEnabled",
] as const;

export function fieldServicesConfigRef(subAccountId: string) {
  return configRef(subAccountId);
}

export async function updateFieldServicesConfig(
  subAccountId: string,
  body: Record<string, unknown>,
): Promise<FieldServicesConfig> {
  const updates: Record<string, unknown> = {};

  if (body.outOfAreaPolicy !== undefined) {
    if (body.outOfAreaPolicy !== "flag" && body.outOfAreaPolicy !== "block") {
      throw new FieldServicesError("Out-of-area policy must be flag or block.");
    }
    updates.outOfAreaPolicy = body.outOfAreaPolicy;
  }
  if (body.timerMaxHours !== undefined) {
    const h = body.timerMaxHours;
    if (typeof h !== "number" || !Number.isFinite(h) || h < 1 || h > 24) {
      throw new FieldServicesError("Timer limit must be between 1 and 24 hours.");
    }
    updates.timerMaxHours = Math.round(h);
  }
  if (body.labourRateMinor !== undefined) {
    const r = body.labourRateMinor;
    if (r !== null && (typeof r !== "number" || !Number.isFinite(r) || r < 0 || r > 100_000_000)) {
      throw new FieldServicesError("Enter a valid hourly rate.");
    }
    updates.labourRateMinor = r === null ? null : Math.round(r);
  }
  if (body.defaultBillingType !== undefined) {
    if (!(SELECTABLE_BILLING_TYPES as string[]).includes(body.defaultBillingType as string)) {
      throw new FieldServicesError("Choose time & materials, day rate or fixed price.");
    }
    updates.defaultBillingType = body.defaultBillingType;
  }
  if (body.jobWord !== undefined || body.jobWordPlural !== undefined) {
    const one = cleanJobWord(body.jobWord, DEFAULT_JOB_WORD);
    updates.jobWord = one;
    updates.jobWordPlural = cleanJobWord(
      body.jobWordPlural,
      one === DEFAULT_JOB_WORD ? DEFAULT_JOB_WORD_PLURAL : `${one}s`,
    );
  }
  if (body.workerWord !== undefined || body.workerWordPlural !== undefined) {
    const one = cleanJobWord(body.workerWord, DEFAULT_WORKER_WORD);
    updates.workerWord = one;
    updates.workerWordPlural = cleanJobWord(
      body.workerWordPlural,
      one === DEFAULT_WORKER_WORD ? DEFAULT_WORKER_WORD_PLURAL : `${one}s`,
    );
  }
  if (body.activityWord !== undefined) {
    updates.activityWord = cleanJobWord(body.activityWord, DEFAULT_ACTIVITY_WORD);
  }
  if (body.labourWord !== undefined) {
    updates.labourWord = cleanJobWord(body.labourWord, DEFAULT_LABOUR_WORD);
  }
  if (body.minEntryMinutes !== undefined) {
    const m = body.minEntryMinutes;
    if (typeof m !== "number" || !Number.isFinite(m) || m < 0 || m > 120) {
      throw new FieldServicesError("The minimum entry must be between 0 and 120 minutes.");
    }
    updates.minEntryMinutes = Math.round(m);
  }
  if (body.maxDayHours !== undefined) {
    const h = body.maxDayHours;
    if (typeof h !== "number" || !Number.isFinite(h) || h < 1 || h > 24) {
      throw new FieldServicesError("The most hours in a day must be between 1 and 24.");
    }
    updates.maxDayHours = Math.round(h * 4) / 4;
  }
  if (body.invoiceDueDays !== undefined) {
    const d = body.invoiceDueDays;
    if (d !== null && (typeof d !== "number" || !Number.isFinite(d) || d < 0 || d > 365)) {
      throw new FieldServicesError("Payment due must be between 0 and 365 days, or no date.");
    }
    updates.invoiceDueDays = d === null ? null : Math.round(d);
  }
  for (const key of ["submitButtonColor", "unlockButtonColor"] as const) {
    if (body[key] !== undefined) {
      if (!(BUTTON_COLOR_IDS as readonly string[]).includes(body[key] as string)) {
        throw new FieldServicesError("Choose one of the listed colours.");
      }
      updates[key] = body[key];
    }
  }
  if (body.routeSuggestionsEnabled !== undefined) {
    if (typeof body.routeSuggestionsEnabled !== "boolean") throw new FieldServicesError("Route suggestions must be on or off.");
    if (body.routeSuggestionsEnabled) {
      const r = await routeReadiness(subAccountId);
      const failed = r.checks.find((c) => !c.ok);
      if (failed) throw new FieldServicesError(`Route suggestions can't be switched on yet: ${failed.label}. ${failed.fix}`);
    }
    updates.routeSuggestionsEnabled = body.routeSuggestionsEnabled;
  }
  if (body.routeAwareSlots !== undefined) {
    if (typeof body.routeAwareSlots !== "boolean") throw new FieldServicesError("Route-aware times must be on or off.");
    if (body.routeAwareSlots) {
      const on =
        body.routeSuggestionsEnabled === true ||
        (body.routeSuggestionsEnabled === undefined && (await getFieldServicesConfig(subAccountId)).routeSuggestionsEnabled === true);
      if (!on) throw new FieldServicesError("Turn on route suggestions first.");
    }
    updates.routeAwareSlots = body.routeAwareSlots;
  }
  if (body.routeReturnToBase !== undefined) {
    if (typeof body.routeReturnToBase !== "boolean") throw new FieldServicesError("Return to base must be on or off.");
    updates.routeReturnToBase = body.routeReturnToBase;
  }
  if (body.routeLeadDays !== undefined) {
    const n = body.routeLeadDays;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 14) throw new FieldServicesError("Choose between 1 and 14 days.");
    updates.routeLeadDays = n;
  }
  if (body.routeMaxDays !== undefined) {
    const n = body.routeMaxDays;
    if (n !== 7 && n !== 14 && n !== 21 && n !== 28) throw new FieldServicesError("Choose 7, 14, 21 or 28 days.");
    updates.routeMaxDays = n;
  }
  if (body.routeLeadDays !== undefined || body.routeMaxDays !== undefined) {
    const now = await getFieldServicesConfig(subAccountId);
    const lead = (updates.routeLeadDays as number | undefined) ?? now.routeLeadDays ?? 1;
    const max = (updates.routeMaxDays as number | undefined) ?? now.routeMaxDays ?? 7;
    if (lead >= max) throw new FieldServicesError("The lead time has to be shorter than how far ahead it works.");
  }
  if (body.customerChangeHours !== undefined) {
    const n = body.customerChangeHours;
    if (typeof n !== "number" || ![0, 24, 48, 72, 96, 168].includes(n)) throw new FieldServicesError("Choose a cutoff from the list.");
    updates.customerChangeHours = n;
  }
  if (body.serviceCategories !== undefined) {
    const cleaned = cleanServiceCategories(body.serviceCategories);
    if ("error" in cleaned) throw new FieldServicesError(cleaned.error);
    updates.serviceCategories = cleaned.list;
  }
  if (body.bookingMaxDays !== undefined) {
    if (body.bookingMaxDays !== 30 && body.bookingMaxDays !== 60 && body.bookingMaxDays !== 90) {
      throw new FieldServicesError("Choose 30, 60 or 90 days.");
    }
    updates.bookingMaxDays = body.bookingMaxDays;
  }
  if (body.bookingServiceIds !== undefined) {
    const ids = body.bookingServiceIds;
    if (!Array.isArray(ids) || ids.length > 30 || ids.some((i) => typeof i !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(i))) {
      throw new FieldServicesError("Choose the services from the list.");
    }
    const db = getAdminDb();
    const docs = (ids as string[]).length > 0 ? await db.getAll(...(ids as string[]).map((i) => db.doc(`products/${i}`))) : [];
    // A Time & materials service is never bookable online, so one left in the list is dropped, not an error.
    const timed = new Set(
      docs.filter((d) => d.exists && d.data()?.subAccountId === subAccountId && d.data()?.billingType === "time_and_materials").map((d) => d.id),
    );
    updates.bookingServiceIds = [...new Set((ids as string[]).filter((i) => !timed.has(i)))];
  }
  if (body.bookingDealPipelineId !== undefined || body.bookingDealStageId !== undefined) {
    const saved = await getFieldServicesConfig(subAccountId);
    const pipelineId =
      typeof body.bookingDealPipelineId === "string" ? body.bookingDealPipelineId : saved.bookingDealPipelineId || "default";
    const pipelines = await loadResolvedPipelines(subAccountId);
    const pipeline = pipelines.find((p) => p.id === pipelineId);
    // Only the pipeline was sent: start at its first open stage, not the stage saved for the old pipeline.
    const stageId =
      body.bookingDealStageId !== undefined
        ? body.bookingDealStageId
        : body.bookingDealPipelineId !== undefined
          ? pipeline?.stages.find((st) => !st.terminal)?.id
          : saved.bookingDealStageId;
    const stage = typeof stageId === "string" ? pipeline?.stages.find((st) => st.id === stageId) : undefined;
    if (!pipeline || !stage || stage.terminal) {
      throw new FieldServicesError("Choose a pipeline and an open stage for new deals.");
    }
    updates.bookingDealPipelineId = pipeline.id;
    updates.bookingDealStageId = stage.id;
  }
  if (body.bookingFooterFields !== undefined) {
    const allowed = ["name", "address", "phone", "email", "website"];
    if (!Array.isArray(body.bookingFooterFields) || body.bookingFooterFields.some((f) => !allowed.includes(f as string))) {
      throw new FieldServicesError("Choose from name, address, phone, email and website.");
    }
    updates.bookingFooterFields = [...new Set(body.bookingFooterFields as string[])];
  }
  for (const key of ["bookingIntro", "bookingDoneMessage"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string") throw new FieldServicesError("That text isn't valid.");
      updates[key] = (body[key] as string).trim().slice(0, 400);
    }
  }
  if (body.timeKinds !== undefined) {
    const kinds = cleanTimeKinds(body.timeKinds, (await getFieldServicesConfig(subAccountId)).timeKinds);
    if (typeof kinds === "string") throw new FieldServicesError(kinds);
    updates.timeKinds = kinds;
  }
  if (body.portalName !== undefined) {
    if (typeof body.portalName !== "string") throw new FieldServicesError("That name isn't valid.");
    updates.portalName = body.portalName.replace(/\s+/g, " ").trim().slice(0, 60);
  }
  if (body.bookingDepositPercent !== undefined) {
    const n = Number(body.bookingDepositPercent);
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new FieldServicesError("The deposit must be between 1 and 100 percent.");
    updates.bookingDepositPercent = Math.round(n);
  }
  if (body.taxPercent !== undefined) {
    const n = Number(body.taxPercent);
    if (!Number.isFinite(n) || n < 0 || n > 50) throw new FieldServicesError("The tax rate must be between 0 and 50 percent.");
    updates.taxPercent = Math.round(n * 100) / 100;
  }
  if (body.taxName !== undefined) {
    if (typeof body.taxName !== "string") throw new FieldServicesError("That text isn't valid.");
    updates.taxName = body.taxName.replace(/\s+/g, " ").trim().slice(0, 30) || "Tax";
  }
  if (body.bookingRefundPolicy !== undefined) {
    if (typeof body.bookingRefundPolicy !== "string") throw new FieldServicesError("That text isn't valid.");
    updates.bookingRefundPolicy = body.bookingRefundPolicy.trim().slice(0, 600);
  }
  if (body.crewAlertChannel !== undefined) {
    if (body.crewAlertChannel !== "email" && body.crewAlertChannel !== "sms") {
      throw new FieldServicesError("Choose email or text.");
    }
    updates.crewAlertChannel = body.crewAlertChannel;
  }
  if (body.bookingTheme !== undefined) {
    if (body.bookingTheme !== "light" && body.bookingTheme !== "dark" && body.bookingTheme !== "auto") {
      throw new FieldServicesError("Choose light, dark or automatic.");
    }
    updates.bookingTheme = body.bookingTheme;
  }
  if (body.bookingStyle !== undefined) {
    if (!isBookingStyleId(body.bookingStyle)) throw new FieldServicesError("Choose one of the listed styles.");
    updates.bookingStyle = body.bookingStyle;
  }
  if (body.bookingAccent !== undefined) {
    const c = body.bookingAccent;
    if (typeof c !== "string" || (c !== "" && !/^#[0-9a-fA-F]{6}$/.test(c))) {
      throw new FieldServicesError("Enter the colour as six hex digits, for example #2563eb.");
    }
    updates.bookingAccent = c.toLowerCase();
  }
  if (body.siteBooking === null) {
    updates.siteBooking = FieldValue.delete();
  } else if (body.siteBookingLook !== undefined) {
    const look = body.siteBookingLook as { accent?: unknown; theme?: unknown; style?: unknown } | null;
    const accent = look?.accent;
    const theme = look?.theme;
    if (typeof accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(accent)) {
      throw new FieldServicesError("Enter the colour as six hex digits, for example #2563eb.");
    }
    if (theme !== "light" && theme !== "dark" && theme !== "auto") {
      throw new FieldServicesError("Choose light, dark or automatic.");
    }
    if (look?.style !== undefined && !isBookingStyleId(look.style)) throw new FieldServicesError("Choose one of the listed styles.");
    const current = (await configRef(subAccountId).get()).data();
    if (!current?.siteBooking) throw new FieldServicesError("There is no website booking page to change.", 404);
    updates.siteBooking = {
      ...current.siteBooking,
      accent: accent.toLowerCase(),
      theme,
      ...(look?.style !== undefined ? { style: look.style } : {}),
      lookEdited: true,
    };
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof body[key] === "boolean") updates[key] = body[key];
  }
  if (body.timesheetsEnabled === true) {
    const current = (await configRef(subAccountId).get()).data();
    if (!current?.timesheetsFirstEnabledAt) updates.timesheetsFirstEnabledAt = FieldValue.serverTimestamp();
  }
  if (Object.keys(updates).length === 0 && body.currency === undefined) {
    throw new FieldServicesError("Nothing to update.");
  }
  if (body.currency !== undefined) {
    updates.currency = await applyWorkspaceCurrency(subAccountId, body.currency);
  }
  await configRef(subAccountId).set(
    { ...updates, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return getFieldServicesConfig(subAccountId);
}
