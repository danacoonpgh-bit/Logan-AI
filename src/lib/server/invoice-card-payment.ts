import "server-only";

import type Stripe from "stripe";

import { getAdminDb } from "@/lib/firebase/admin";
import { computeQuoteTotals, effectiveQuoteStatus } from "@/lib/quotes/calc";
import { mapStripeSessionError } from "@/lib/stripe/session-error";
import {
  createCheckoutSessionForSubAccount,
  getSubAccountStripe,
  StripeConnectionError,
} from "@/lib/stripe/sub-account-client";
import { currencyExponent } from "@/lib/field-services/money";
import { DEPOSIT_CHECKOUT_MS, keepDepositHoldUntil } from "@/lib/server/field-booking-deposit-service";
import { createPendingOrder } from "@/lib/server/orders-service";
import type { Quote } from "@/types/quotes";
import type { OrderLineItem } from "@/types/orders";

/** A refusal that is safe to show the payer, with the status to answer with. */
export class InvoicePayError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Why an invoice cannot be paid by card right now, or null when it can. Needs no Stripe call. */
export function invoiceCardBlock(quote: Quote, paymentsEnabled: boolean): string | null {
  if (quote.kind !== "invoice") return "Only invoices can be paid online.";
  if (quote.status === "paid") return "This invoice has already been paid.";
  if (quote.fieldDeposit && Date.now() > quote.fieldDeposit.expiresAtMs) {
    return "The time held for this booking has ended. Please book again.";
  }
  if (effectiveQuoteStatus(quote) === "expired") return "This invoice has expired. Please ask for a new one.";
  if (quote.status !== "sent" && quote.status !== "viewed") return "This invoice isn't ready for payment.";
  if (!paymentsEnabled) return "Card payment isn't available for this invoice.";
  // The charge is worked out in hundredths, which would be 100 times too much in a currency without them.
  if (currencyExponent(quote.currency || "USD") !== 2) return "Card payment isn't available in this currency.";
  if (computeQuoteTotals(quote).total <= 0) return "This invoice has nothing to pay.";
  return null;
}

/**
 * Starts a Stripe Checkout for one invoice and returns its address. The amount
 * is recomputed from the invoice's lines, the same way the page and PDF do, so
 * the charge matches what was shown. The webhook marks the invoice paid.
 * The caller has already proved who is paying; this only checks the invoice.
 */
export async function startInvoiceCardPayment(input: {
  quote: Quote;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const { quote } = input;

  const subSnap = await getAdminDb().doc(`subAccounts/${quote.subAccountId}`).get();
  const block = invoiceCardBlock(quote, subSnap.data()?.paymentsEnabledByAgency === true);
  if (block) throw new InvoicePayError(block, 409);

  const totals = computeQuoteTotals(quote);
  const currency = (quote.currency || "USD").toLowerCase();
  // Quote line items are whole units (legacy schema); orders are cents.
  const totalCents = Math.round(totals.total * 100);
  const lineItems: OrderLineItem[] = [
    {
      productId: null,
      name: `Invoice ${quote.quoteNumber}`,
      description: "",
      unitPriceCents: totalCents,
      quantity: 1,
      isBump: false,
    },
  ];

  // Fail fast with a specific message when the workspace isn't connected or
  // its webhook isn't set up, instead of a generic session-create error.
  try {
    await getSubAccountStripe(quote.subAccountId);
  } catch (err) {
    if (err instanceof StripeConnectionError) {
      console.error(`[invoice-pay] connection unusable sa=${quote.subAccountId} code=${err.code}`);
      throw new InvoicePayError(
        "Card payment is temporarily unavailable. Please use the other payment option or contact the sender.",
        503,
      );
    }
    throw err;
  }

  // A booking deposit's card page closes on its own, so a payment cannot arrive long after the held time is gone.
  const payByMs = quote.fieldDeposit ? Date.now() + DEPOSIT_CHECKOUT_MS : null;

  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSessionForSubAccount({
      subAccountId: quote.subAccountId,
      params: {
        mode: "payment",
        ...(payByMs ? { expires_at: Math.floor(payByMs / 1000) } : {}),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: totalCents,
              product_data: { name: `Invoice ${quote.quoteNumber}` },
            },
          },
        ],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: {
          leadstackSubAccountId: quote.subAccountId,
          leadstackQuoteId: quote.id,
        },
      },
    });
  } catch (err) {
    const mapped = mapStripeSessionError(err);
    console.error(`[invoice-pay] stripe session failed quote=${quote.id} — ${mapped.logDetail}`);
    throw new InvoicePayError(mapped.buyerMessage, mapped.status);
  }

  if (!session.url) throw new InvoicePayError("Card payment is temporarily unavailable.", 502);

  try {
    await createPendingOrder({
      agencyId: quote.agencyId,
      subAccountId: quote.subAccountId,
      contactId: quote.contactId,
      checkoutPageId: null,
      quoteId: quote.id,
      source: "quote",
      currency,
      lineItems,
      stripeCheckoutSessionId: session.id,
      livemode: session.livemode,
      buyerEmail: null,
      buyerName: null,
      attribution: null,
    });
  } catch (err) {
    // No order row means the webhook can't mark the invoice paid, so don't take the payment.
    console.error(`[invoice-pay] pending order write failed quote=${quote.id}`, err);
    throw new InvoicePayError("Card payment is temporarily unavailable.", 500);
  }

  if (payByMs) {
    // The time stays held while this card page is open. If that fails, a late payment goes to the office to sort out.
    const kept = await keepDepositHoldUntil(quote.id, payByMs).catch((err) => {
      console.warn(`[invoice-pay] keeping the held time failed quote=${quote.id}`, err);
      return false;
    });
    if (!kept) console.warn(`[invoice-pay] held time not extended quote=${quote.id}`);
  }

  return session.url;
}
