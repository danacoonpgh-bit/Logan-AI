import { NextResponse } from "next/server";
import { portalClientIp } from "@/lib/field-portal/guard";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { quoteBooking } from "@/lib/server/field-booking-service";
import { hitLimit } from "@/lib/server/field-rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request, { params }: { params: Promise<{ subAccountId: string }> }) {
  const { subAccountId } = await params;
  const ip = portalClientIp(request);
  const [perIp, perPage] = await Promise.all([
    hitLimit(`fsb-quote:${ip}:${subAccountId}`, 240, 3_600_000),
    hitLimit(`fsb-quote-page:${subAccountId}`, 1_500, 3_600_000),
  ]);
  if (!perIp.ok || !perPage.ok) {
    return NextResponse.json({ error: "Too many checks. Try again later." }, { status: 429, headers: NO_STORE });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await quoteBooking(subAccountId, body), { headers: NO_STORE });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
