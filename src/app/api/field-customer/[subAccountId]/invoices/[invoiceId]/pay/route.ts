import { cookies } from "next/headers";
import { json, sameOrigin } from "@/lib/field-portal/guard";
import { getAdminDb } from "@/lib/firebase/admin";
import { checkCheckoutRateLimit, clientIpFrom } from "@/lib/checkout/rate-limit";
import {
  customerCookieName,
  readCustomerSession,
  requirePortalOpen,
} from "@/lib/server/field-customer-auth-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { InvoicePayError, startInvoiceCardPayment } from "@/lib/server/invoice-card-payment";
import type { Quote } from "@/types/quotes";

export const dynamic = "force-dynamic";

/** Pay one of the signed-in customer's invoices by card. The session is the credential; the invoice must be theirs. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ subAccountId: string; invoiceId: string }> },
) {
  if (!sameOrigin(request)) return json({ error: "Not allowed." }, 403);
  const { subAccountId, invoiceId } = await params;
  try {
    await requirePortalOpen(subAccountId);
    const jar = await cookies();
    const session = await readCustomerSession(jar.get(customerCookieName(subAccountId))?.value, subAccountId);
    if (!session) return json({ error: "Sign in to continue." }, 401);

    const rate = checkCheckoutRateLimit(clientIpFrom(request));
    if (!rate.ok) return json({ error: "Too many attempts. Please try again shortly." }, 429);

    if (!/^[A-Za-z0-9_-]{6,64}$/.test(invoiceId)) return json({ error: "That invoice wasn't found." }, 404);
    const snap = await getAdminDb().doc(`quotes/${invoiceId}`).get();
    const data = snap.data() as Omit<Quote, "id"> | undefined;
    // The same answer for missing and for someone else's, so ids can't be probed.
    if (!snap.exists || !data || data.subAccountId !== subAccountId || data.contactId !== session.contactId) {
      return json({ error: "That invoice wasn't found." }, 404);
    }
    const quote = { id: snap.id, ...data } as Quote;

    const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
    const page = `${base}/customer/${subAccountId}`;
    try {
      const url = await startInvoiceCardPayment({
        quote,
        successUrl: `${page}?paid=1`,
        cancelUrl: `${page}?cancelled=1`,
      });
      return json({ url });
    } catch (err) {
      if (err instanceof InvoicePayError) return json({ error: err.message }, err.status);
      throw err;
    }
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
