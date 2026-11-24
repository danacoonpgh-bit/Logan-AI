import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { hasCardRail } from "@/lib/payments/can-take-payment";
import { publishCallback } from "@/lib/automations/qstash";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { minorToUnit, unitToMinor } from "@/lib/field-services/money";
import { issueQuoteNumber } from "@/lib/quotes/number";
import { issueQuoteToken } from "@/lib/quotes/token";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { GLOBAL_TERRITORY_ID } from "@/types";
import { DEFAULT_QUOTE } from "@/types/quotes";
import type { FieldServicesConfig, Job } from "@/types/field-services";
import type { Contact } from "@/types/contacts";
import type { Quote } from "@/types/quotes";
import type { SubAccountDoc } from "@/types/tenancy";

/** How long a held time waits for its deposit. */
export const DEPOSIT_HOLD_MS = 30 * 60_000;

/** How long a deposit's card page stays open. The shortest Stripe allows, plus a minute for clock drift. */
export const DEPOSIT_CHECKOUT_MS = 31 * 60_000;

/** The deposit for one service in minor units. Zero when deposits are off, cannot be taken, or the service takes none. */
export function depositMinorFor(input: {
  sub: Partial<SubAccountDoc> | null;
  config: Pick<FieldServicesConfig, "bookingDepositEnabled" | "bookingDepositPercent">;
  priceMinor: number;
  currency: string;
  servicePercent: number | null | undefined;
}): number {
  if (input.config.bookingDepositEnabled !== true) return 0;
  if (!hasCardRail(input.sub)) return 0;
  // The card page charges in hundredths, so only two-decimal currencies take a deposit.
  if (unitToMinor(input.currency, 1) !== 100) return 0;
  const percent = typeof input.servicePercent === "number" ? input.servicePercent : (input.config.bookingDepositPercent ?? 20);
  if (!(percent > 0) || input.priceMinor <= 0) return 0;
  return Math.min(input.priceMinor, Math.round((input.priceMinor * percent) / 100));
}

/** Whether a card payment can be taken for this booking at all: a ready card rail and a two-decimal currency. */
export function cardPayAvailable(sub: Partial<SubAccountDoc> | null, currency: string): boolean {
  return hasCardRail(sub) && unitToMinor(currency, 1) === 100;
}

type Hold = NonNullable<NonNullable<Quote["fieldDeposit"]>["hold"]>;

/** Gives a held time back. Safe to run twice. */
export async function releaseHold(hold: Hold | null | undefined): Promise<void> {
  if (!hold) return;
  const db = getAdminDb();
  await Promise.all(
    [{ docPath: hold.docPath, token: hold.token }, ...(hold.extra ?? [])].map((h) =>
      db
        .doc(h.docPath)
        .update({ [`holds.${h.token}`]: FieldValue.delete() })
        .catch(() => {}),
    ),
  );
}

/**
 * Makes the deposit invoice for an online booking and queues the check that releases the held time if it is not paid.
 * Throws, leaving nothing behind, when the invoice or the check cannot be set up.
 */
export async function createDepositInvoice(input: {
  sub: SubAccountDoc & { id: string };
  job: Job;
  hold: Hold | null;
  allowText: boolean;
  amountMinor: number;
  serviceName: string;
  policy: string;
  /** The whole price is being paid, not a deposit. */
  full?: boolean;
}): Promise<{ quoteId: string; token: string }> {
  const db = getAdminDb();
  const { job } = input;
  const quoteNumber = await issueQuoteNumber(job.subAccountId, "invoice");
  const ref = db.collection("quotes").doc();
  const { token, hash } = issueQuoteToken(ref.id);
  const expiresAtMs = Date.now() + DEPOSIT_HOLD_MS;
  const contact = (await db.doc(`contacts/${job.contactId}`).get()).data() ?? {};
  const doc: Omit<Quote, "id"> = {
    ...DEFAULT_QUOTE,
    kind: "invoice",
    status: "sent",
    sentAt: FieldValue.serverTimestamp(),
    viewedAt: null,
    agencyId: job.agencyId,
    subAccountId: job.subAccountId,
    createdByUid: "booking-page",
    contactId: job.contactId,
    quoteNumber,
    publicTokenHash: hash,
    territoryId: (contact.territoryId as string | undefined) ?? job.territoryId ?? GLOBAL_TERRITORY_ID,
    currency: job.currency,
    lineItems: [
      {
        id: crypto.randomUUID(),
        description: `${input.full ? "Payment in full" : "Deposit"}: ${input.serviceName}`,
        quantity: 1,
        unitPrice: minorToUnit(job.currency, input.amountMinor),
        productId: null,
      },
    ],
    termsAndNotes: [`${job.number}: ${job.title}`, input.policy].filter(Boolean).join("\n\n"),
    jobId: job.id,
    requestId: job.requestId ?? null,
    fieldDeposit: {
      jobId: job.id,
      instant: !!input.hold,
      allowText: input.allowText,
      expiresAtMs,
      hold: input.hold,
      ...(input.full ? { full: true } : {}),
    },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  try {
    await ref.set(doc);
    await db.doc(`jobs/${job.id}`).update({ depositInvoiceId: ref.id, updatedAt: FieldValue.serverTimestamp() });
    // Without the queue nothing would ever release the time, so the booking cannot take a deposit.
    const queued = await publishCallback({
      pathname: "/api/field-booking/deposit/expire-step",
      body: { quoteId: ref.id },
      delaySeconds: Math.ceil((DEPOSIT_HOLD_MS + 60_000) / 1000),
      deduplicationId: `dep_expire_${ref.id}`,
    });
    if (!queued) throw new Error("the expiry check could not be queued");
  } catch (err) {
    await ref.delete().catch(() => {});
    await db.doc(`jobs/${job.id}`).update({ depositInvoiceId: FieldValue.delete() }).catch(() => {});
    throw err;
  }
  return { quoteId: ref.id, token };
}

/**
 * Keeps a booking's held time while a card page that was opened in time can still be paid.
 * Returns false when it could not, and a payment that then arrives late is handed to the office.
 */
export async function keepDepositHoldUntil(quoteId: string, untilMs: number): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`quotes/${quoteId}`);
  // The later check is queued first. Without it nothing would release the time once the card page closes.
  const queued = await publishCallback({
    pathname: "/api/field-booking/deposit/expire-step",
    body: { quoteId },
    delaySeconds: Math.ceil((untilMs + 60_000 - Date.now()) / 1000),
    deduplicationId: `dep_expire_${quoteId}_${untilMs}`,
  });
  if (!queued) return false;
  return db.runTransaction(async (tx) => {
    const quote = (await tx.get(ref)).data() as Quote | undefined;
    const fd = quote?.fieldDeposit;
    if (!quote || !fd || (quote.status !== "sent" && quote.status !== "viewed")) return false;
    if ((fd.payByMs ?? 0) >= untilMs) return true;
    const holds = fd.hold ? [{ docPath: fd.hold.docPath, token: fd.hold.token }, ...(fd.hold.extra ?? [])] : [];
    const snaps = await Promise.all(holds.map((h) => tx.get(db.doc(h.docPath))));
    tx.update(ref, { "fieldDeposit.payByMs": untilMs });
    snaps.forEach((snap, i) => {
      // A hold that was already given back stays gone.
      if (snap.data()?.holds?.[holds[i].token]) {
        tx.update(snap.ref, { [`holds.${holds[i].token}.x`]: untilMs + 120_000 });
      }
    });
    return true;
  });
}

/** Gives the time back when the deposit was not paid. Runs from the queue after the hold. */
export async function expireDepositBooking(quoteId: string): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`quotes/${quoteId}`);
  // One step flips the invoice and cancels an instant booking's job, and does nothing if a payment got there first.
  const outcome = await db.runTransaction(async (tx) => {
    const quote = (await tx.get(ref)).data() as Quote | undefined;
    const fd = quote?.fieldDeposit;
    if (!quote || !fd) return null;
    if (quote.status !== "sent" && quote.status !== "viewed") return null;
    // A card page is still open, so the time stays held. Another check is queued for when that page closes.
    if (fd.payByMs && Date.now() < fd.payByMs) return null;
    const jobRef = db.doc(`jobs/${fd.jobId}`);
    const job = (await tx.get(jobRef)).data() as Job | undefined;
    tx.update(ref, { status: "expired", updatedAt: FieldValue.serverTimestamp() });
    if (job && job.subAccountId === quote.subAccountId && fd.instant && job.status !== "closed") {
      tx.update(jobRef, { status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
    }
    return { quote, fd, job: job && job.subAccountId === quote.subAccountId ? { ...job, id: fd.jobId } : null };
  });
  if (!outcome) return;
  const { quote, fd, job } = outcome;
  await releaseHold(fd.hold);
  if (!job) return;

  const sub = (await db.doc(`subAccounts/${quote.subAccountId}`).get()).data() as SubAccountDoc | undefined;
  // The office hears about it either way, so a booking that fell through can be chased.
  await createTaskServerSide({
    subAccountId: job.subAccountId,
    agencyId: job.agencyId,
    createdByUid: "booking-page",
    mode: "live",
    title: `${fd.full ? "Payment" : "Deposit"} not paid for ${job.number}`,
    notes: fd.instant
      ? `${job.title}. The customer did not pay${fd.full ? "" : " the deposit"}, so the booking was cancelled and the time was released.`
      : `${job.title}. The customer did not pay${fd.full ? "" : " the deposit"}, so the request is still open for you to follow up.`,
    dueAt: null,
    contactId: job.contactId,
    dealId: job.dealId ?? null,
    eventId: null,
  }).catch(() => {});

  const contact = (await db.doc(`contacts/${job.contactId}`).get()).data() as Contact | undefined;
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  if (sub && contact?.email && !contact.emailOptedOut && !contact.emailBouncedAt && emailIsConfigured()) {
    await sendEmail({
      to: contact.email,
      subject: fd.instant ? "Your booking was not confirmed" : `Your ${fd.full ? "payment" : "deposit"} was not received`,
      text: fd.instant
        ? `We did not receive the ${fd.full ? "payment" : "deposit"} for "${job.title}", so the time was released. You can book again here: ${base}/book-service/${job.subAccountId}`
        : `We did not receive the ${fd.full ? "payment" : "deposit"} for "${job.title}". We will be in touch about your request.`,
      replyTo: sub.replyToEmail ?? undefined,
      from: tenantFrom({ ...sub, id: job.subAccountId } as SubAccountDoc & { id: string }),
      meter: { subAccountId: job.subAccountId },
    }).catch((err) => console.warn("[field-booking] expiry email failed", err));
  }
}
