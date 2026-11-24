import { NextResponse } from "next/server";
import { portalClientIp, sameOrigin } from "@/lib/field-portal/guard";
import { customerMoveSlots } from "@/lib/server/field-customer-change-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string; visitId: string }> }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { token, visitId } = await params;
  const body = (await request.json().catch(() => null)) as { date?: unknown } | null;
  try {
    const out = await customerMoveSlots({ token, visitId, date: body?.date, ip: portalClientIp(request) });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
