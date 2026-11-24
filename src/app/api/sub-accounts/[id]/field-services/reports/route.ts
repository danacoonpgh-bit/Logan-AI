import { NextResponse } from "next/server";
import { fieldProfitReport } from "@/lib/server/field-profit-report-service";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { fieldReport } from "@/lib/server/field-reports-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const asked = Number(new URL(request.url).searchParams.get("days"));
  const days = [7, 30, 90, 365].includes(asked) ? asked : 30;
  try {
    if (new URL(request.url).searchParams.get("view") === "profit") {
      return NextResponse.json(await fieldProfitReport(subAccountId, days), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json(await fieldReport(subAccountId, days), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
