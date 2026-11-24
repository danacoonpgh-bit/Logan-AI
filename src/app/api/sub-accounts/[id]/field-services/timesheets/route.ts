import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { listWeekForOffice } from "@/lib/server/field-timesheet-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    const res = NextResponse.json(
      await listWeekForOffice(subAccountId, new URL(request.url).searchParams.get("week")),
    );
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
