import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { todayForUser } from "@/lib/server/field-today-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    const res = await todayForUser({ subAccountId, uid: guard.access.uid });
    const response = NextResponse.json(res);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
