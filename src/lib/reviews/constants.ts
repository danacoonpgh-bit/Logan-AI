// Review-request constants shared by the server dispatcher and the client UI.

/** Pre-filled SMS body. Tags: {{firstName}} / {{businessName}} / {{reviewUrl}}. */
export const DEFAULT_REVIEW_SMS_TEMPLATE =
  "Hi {{firstName}}, thanks for choosing {{businessName}}! If you have a moment, a quick Google review would mean a lot: {{reviewUrl}}";

export const DEFAULT_REVIEW_COOLDOWN_DAYS = 90;

/** "Rate first": the question sent before any Google link. Tags: {{firstName}} / {{businessName}}. */
export const DEFAULT_RATING_PROMPT =
  "Hi {{firstName}}, thanks for choosing {{businessName}}! How did we go? Reply with a number from 1 (poor) to 5 (great).";

/** Sent for a score below the threshold. No link. */
export const DEFAULT_RATING_LOW_REPLY =
  "Thanks for letting us know, {{firstName}}. We're sorry we missed the mark and someone from {{businessName}} will be in touch to put it right.";

/** Lowest score that gets the Google link when rate first is on. */
export const DEFAULT_MIN_RATING = 4;

/** How long a customer has to answer the rating question. */
export const RATING_REPLY_WINDOW_DAYS = 7;

export function fillReviewTemplate(
  template: string,
  v: { firstName: string; businessName: string; reviewUrl?: string },
): string {
  return template
    .replace(/{{\s*firstName\s*}}/g, v.firstName)
    .replace(/{{\s*businessName\s*}}/g, v.businessName)
    .replace(/{{\s*reviewUrl\s*}}/g, v.reviewUrl ?? "");
}

/**
 * "sms": free-form SMS. "whatsapp_template": approved template, works outside
 * the 24h window (needed for auto-sends). "whatsapp_manual": free-form WhatsApp,
 * only while the customer's 24h window is open; best from the inbox.
 */
export type ReviewChannel = "sms" | "whatsapp_template" | "whatsapp_manual";

/** Also maps the old two-option "whatsapp" value. */
export function normalizeReviewChannel(
  raw: string | null | undefined,
): ReviewChannel {
  if (raw === "sms" || raw === "whatsapp_template" || raw === "whatsapp_manual") {
    return raw;
  }
  if (raw === "whatsapp") return "whatsapp_template"; // legacy value
  return "sms";
}

export function isWhatsappReviewChannel(ch: ReviewChannel): boolean {
  return ch === "whatsapp_template" || ch === "whatsapp_manual";
}
