import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { exportTimeCsv } from "@/lib/server/field-timesheet-export-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    const q = new URL(request.url).searchParams;
    const { csv, filename } = await exportTimeCsv({ subAccountId, from: q.get("from"), to: q.get("to") });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
