import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { verifyQuoteToken } from "@/lib/quotes/token";
import { checkCheckoutRateLimit, clientIpFrom } from "@/lib/checkout/rate-limit";
import { InvoicePayError, startInvoiceCardPayment } from "@/lib/server/invoice-card-payment";
import type { Quote } from "@/types/quotes";

export const dynamic = "force-dynamic";

/**
 * Public "Pay by card" for an invoice. The HMAC token is the credential (same
 * as /api/quotes/[token]/respond): verify it, then compare its hash to
 * `publicTokenHash` so a re-sent invoice kills older links.
 *
 * No request body. The charge is worked out by `startInvoiceCardPayment`, the
 * same code the customer portal uses. On payment the webhook marks the order
 * and invoice paid via markQuotePaidServerSide(), the same path as manual
 * "Mark as paid". Invoices without Stripe keep their paypal.me link.
 */

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const rate = checkCheckoutRateLimit(clientIpFrom(request));
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  const verified = verifyQuoteToken(token);
  // 404 so a bad token never confirms the invoice exists.
  if (!verified) return fail("This payment link isn't valid.", 404);

  const snap = await getAdminDb().doc(`quotes/${verified.quoteId}`).get();
  if (!snap.exists) return fail("This payment link isn't valid.", 404);

  const quote = { id: snap.id, ...(snap.data() as Omit<Quote, "id">) } as Quote;
  if (quote.publicTokenHash !== verified.hash) {
    return fail(
      "A newer version of this invoice has been sent. Please use the most recent email.",
      404,
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  try {
    const url = await startInvoiceCardPayment({
      quote,
      successUrl: `${base}/q/${token}?paid=1`,
      cancelUrl: `${base}/q/${token}?cancelled=1`,
    });
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof InvoicePayError) return fail(err.message, err.status);
    throw err;
  }
}
