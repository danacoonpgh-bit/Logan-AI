import { NextResponse } from "next/server";
import { portalClientIp } from "@/lib/field-portal/guard";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { checkBookingArea } from "@/lib/server/field-booking-service";
import { hitLimit } from "@/lib/server/field-rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ subAccountId: string }> },
) {
  const { subAccountId } = await params;
  const ip = portalClientIp(request);
  if (!(await hitLimit(`fsb-area:${ip}:${subAccountId}`, 60, 3_600_000)).ok) {
    return NextResponse.json({ error: "Too many checks. Try again later." }, { status: 429, headers: NO_STORE });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await checkBookingArea(subAccountId, body.country, body.postcode, { line1: body.line1, city: body.city, region: body.region }), { headers: NO_STORE });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
