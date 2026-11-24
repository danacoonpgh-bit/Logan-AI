import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { docContext } from "@/lib/field-services/route-helpers";
import { FieldServicesError, fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { createDocumentFromJob } from "@/lib/server/field-documents-service";
import { renderQuotePdfBuffer } from "@/lib/quotes/pdf-render";
import type { Quote } from "@/types/quotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Renders the invoice a draft would produce, as the same PDF the customer gets, without saving anything.
 * The hours or parts left off come back in headers.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const { id: subAccountId, jobId } = await params;
  const ctx = await docContext(request, subAccountId, "jobs", jobId);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.actor.isOffice) return fieldServicesErrorResponse(new FieldServicesError("Only the office can do this.", 403));

  let body: { includeTravelFee?: boolean; visitId?: string; weekEnding?: string; weeks?: number | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await createDocumentFromJob({
      subAccountId,
      jobId,
      kind: "invoice",
      preview: true,
      createdByUid: ctx.guard.access.uid,
      options: {
        includeTravelFee: body.includeTravelFee === true,
        weekEnding: typeof body.weekEnding === "string" ? body.weekEnding : undefined,
        weeks: typeof body.weeks === "number" ? body.weeks : null,
        includeLabour: true,
        includeParts: true,
        visitId: typeof body.visitId === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(body.visitId) ? body.visitId : undefined,
      },
    });
    if (!result.preview) throw new FieldServicesError("The preview could not be made.", 500);

    const db = getAdminDb();
    const document = result.preview.document as unknown as Omit<Quote, "id">;
    const [contactSnap, subSnap] = await Promise.all([
      db.doc(`contacts/${document.contactId}`).get(),
      db.doc(`subAccounts/${subAccountId}`).get(),
    ]);
    const contact = (contactSnap.data() ?? {}) as { name?: string; email?: string; phone?: string };
    const sub = subSnap.data() ?? {};
    const now = new Date();
    const quote = { ...document, id: "preview", createdAt: now, updatedAt: now } as unknown as Quote;
    const pdf = await renderQuotePdfBuffer({
      quote,
      businessName: (sub.name as string | undefined) || "Your business",
      businessLogoUrl: typeof sub.logoUrl === "string" ? (sub.logoUrl as string) : null,
      recipientName: contact.name?.trim() || contact.email?.trim() || contact.phone?.trim() || "Customer",
    });
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="invoice-preview.pdf"',
        "Cache-Control": "no-store",
        "X-Hours-Waiting": String(result.hoursWaiting ?? 0),
        "X-Parts-Unpriced": String(result.partsUnpriced ?? 0),
      },
    });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
