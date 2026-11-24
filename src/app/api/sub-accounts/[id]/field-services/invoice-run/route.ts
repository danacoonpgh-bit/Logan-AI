import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { invoiceRunWeeks, previewInvoiceRun, runInvoices } from "@/lib/server/field-invoice-run-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const url = new URL(request.url);
  try {
    if (url.searchParams.get("weeksOnly") === "1") {
      return NextResponse.json(await invoiceRunWeeks(subAccountId), { headers: NO_STORE });
    }
    const weeksParam = url.searchParams.get("weeks");
    const preview = await previewInvoiceRun({
      subAccountId,
      weekEnding: url.searchParams.get("weekEnding") ?? undefined,
      weeks: weeksParam ? Number(weeksParam) : null,
      includeParts: url.searchParams.get("includeParts") !== "0",
    });
    return NextResponse.json(preview, { headers: NO_STORE });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = await readJson(request);
  if (!body) return badJson();
  try {
    const results = await runInvoices({
      subAccountId,
      createdByUid: guard.access.uid,
      weekEnding: body.weekEnding,
      weeks: typeof body.weeks === "number" ? body.weeks : null,
      jobIds: body.jobIds,
      includeParts: body.includeParts === true,
    });
    return NextResponse.json({ results }, { headers: NO_STORE });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
