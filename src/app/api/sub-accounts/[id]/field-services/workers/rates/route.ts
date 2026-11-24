import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { listWorkerRates } from "@/lib/server/field-worker-rates-service";

export const dynamic = "force-dynamic";

/** Every person's cost and sell rate, for pricing an estimate by staff member. Admins only: these are pay figures. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    const rates = await listWorkerRates(subAccountId);
    return NextResponse.json({ rates: Object.fromEntries(rates) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
