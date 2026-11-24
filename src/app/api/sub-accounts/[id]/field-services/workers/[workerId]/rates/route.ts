import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { getWorkerRates, setWorkerRates } from "@/lib/server/field-worker-rates-service";

export const dynamic = "force-dynamic";

/** A person's cost and sell rates. Admins only: these are pay figures. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; workerId: string }> }) {
  const { id: subAccountId, workerId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    return NextResponse.json(await getWorkerRates(subAccountId, workerId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string; workerId: string }> }) {
  const { id: subAccountId, workerId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = await readJson(request);
  if (!body) return badJson();
  try {
    return NextResponse.json(await setWorkerRates({ subAccountId, workerId, body }));
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
