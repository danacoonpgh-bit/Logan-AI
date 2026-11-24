import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { sendPushForEvent } from "@/lib/push/send";
import {
  DEFAULT_MIN_RATING,
  DEFAULT_RATING_LOW_REPLY,
  DEFAULT_REVIEW_SMS_TEMPLATE,
  RATING_REPLY_WINDOW_DAYS,
  fillReviewTemplate,
} from "@/lib/reviews/constants";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

/** "4", "4/5", "5 stars", "3." but never a sentence that merely contains a digit. */
export function parseRating(body: string): number | null {
  const m = /^\s*([1-5])\s*(?:\/\s*5|stars?)?\s*[.!]?\s*$/i.exec(body ?? "");
  return m ? Number(m[1]) : null;
}

function toMillis(v: unknown): number | null {
  const maybe = v as { toMillis?: () => number } | null | undefined;
  return maybe && typeof maybe.toMillis === "function" ? maybe.toMillis() : null;
}

function firstWord(s: string): string {
  const t = (s ?? "").trim();
  const i = t.indexOf(" ");
  return i === -1 ? t : t.slice(0, i);
}

/**
 * A customer's reply to the "How did we go?" text. At or above the threshold they get the
 * Google review message; below it a short thank-you and the team is alerted. Returns true when
 * the reply was a rating we were waiting for, so the caller skips the AI auto-reply.
 */
export async function handleRatingReply(input: {
  subAccountId: string;
  agencyId: string;
  subAccount: SubAccountDoc;
  contactId: string;
  contact: Contact;
  body: string;
  from: string;
}): Promise<boolean> {
  const cfg = input.subAccount.googleReviewConfig;
  if (!cfg || cfg.rateFirst !== true || !cfg.reviewUrl) return false;
  const askedMs = toMillis(input.contact.reviewRatingAskedAt);
  if (!askedMs || Date.now() - askedMs > RATING_REPLY_WINDOW_DAYS * 86_400_000) return false;
  const rating = parseRating(input.body);
  if (rating === null) return false;

  const db = getAdminDb();
  const contactRef = db.doc(`contacts/${input.contactId}`);
  // Claim the pending ask first so a retried webhook cannot send a second reply.
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(contactRef);
    if (!toMillis(snap.data()?.reviewRatingAskedAt)) return false;
    tx.update(contactRef, {
      reviewRatingAskedAt: null,
      reviewRating: rating,
      reviewRatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (!claimed) return false;

  const min = cfg.minRating && cfg.minRating >= 1 && cfg.minRating <= 5 ? cfg.minRating : DEFAULT_MIN_RATING;
  const high = rating >= min;
  const vars = { firstName: firstWord(input.contact.name ?? ""), businessName: input.subAccount.name ?? "", reviewUrl: cfg.reviewUrl };
  const blocked = smsSendBlock(input.contact);
  const reply = fillReviewTemplate(high ? cfg.messageTemplate || DEFAULT_REVIEW_SMS_TEMPLATE : DEFAULT_RATING_LOW_REPLY, vars);

  let sent = false;
  try {
    if (blocked) throw new Error("opted out");
    const res = await sendSmsForSubAccount({
      subAccountId: input.subAccountId,
      subAccount: input.subAccount,
      to: input.from,
      body: reply,
    });
    if (res.mode === "dedicated") {
      await contactRef.collection("messages").doc(res.sid).set({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        contactId: input.contactId,
        direction: "outbound",
        status: "sent",
        body: reply,
        from: res.from,
        to: input.from,
        twilioMessageSid: res.sid,
        sentByUid: "review-request",
        error: null,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
      await upsertConversationForMessage({
        contactId: input.contactId,
        subAccountId: input.subAccountId,
        agencyId: input.agencyId,
        contactName: input.contact.name ?? "",
        contactPhone: input.from,
        channel: "sms",
        direction: "outbound",
        body: reply,
      });
    }
    sent = true;
  } catch (err) {
    console.warn("[reviews/rating] reply send failed", err);
    // Let the customer answer again rather than losing the link, unless they opted
    // out (the ask would never clear). Keep the original ask time so the 7-day
    // window does not restart, and drop the rating so it cannot trigger the
    // duplicate-answer guard.
    if (!blocked) {
      await contactRef
        .update({
          reviewRatingAskedAt: Timestamp.fromMillis(askedMs),
          reviewRating: null,
          reviewRatedAt: null,
        })
        .catch(() => undefined);
    }
  }

  try {
    await contactRef.collection("activities").add({
      type: "review_requested",
      content: !sent
        ? `Rated ${rating}/5 but the reply could not be sent.`
        : high
          ? `Rated ${rating}/5. Google review link sent.`
          : `Rated ${rating}/5, below your ${min}-star threshold. No Google link sent.`,
      createdBy: "review-request",
      meta: { rating, linkSent: high && sent },
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn("[reviews/rating] activity write failed", err);
  }

  if (!high) {
    await sendPushForEvent({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      title: `${input.contact.name || "A customer"} rated you ${rating}/5`,
      body: "Worth a call to put it right.",
      url: `/sa/${input.subAccountId}/contacts/${input.contactId}`,
      tag: `rating-${input.contactId}`,
    });
  }
  return true;
}
