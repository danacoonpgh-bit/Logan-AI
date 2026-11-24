import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { fieldDashboardStats } from "@/lib/server/field-dashboard-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json(await fieldDashboardStats(subAccountId), { headers: { "Cache-Control": "no-store" } });
}
