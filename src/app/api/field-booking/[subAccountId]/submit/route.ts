import { NextResponse } from "next/server";
import { portalClientIp } from "@/lib/field-portal/guard";
import { checkFormSpam, ELAPSED_BODY_KEY, HONEYPOT_BODY_KEY } from "@/lib/forms/spam-guard";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { submitBookingRequest } from "@/lib/server/field-booking-service";
import { hitLimit } from "@/lib/server/field-rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ subAccountId: string }> },
) {
  const { subAccountId } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  }
  const ip = portalClientIp(request);

  const verdict = checkFormSpam({
    ip,
    formId: `fsb_${subAccountId}`,
    honeypot: body[HONEYPOT_BODY_KEY],
    elapsedMs: body[ELAPSED_BODY_KEY],
  });
  // A bot is told it worked and nothing is created.
  if (verdict.kind === "trap") {
    console.warn("[field-booking] request dropped by the bot check:", verdict.reason, subAccountId);
    return NextResponse.json({ ok: true, number: "", statusUrl: null }, { headers: NO_STORE });
  }
  const tooMany = NextResponse.json(
    { error: "Too many requests. Please try again later." },
    { status: 429, headers: { ...NO_STORE, "Retry-After": "600" } },
  );
  if (verdict.kind === "rate_limited") return tooMany;
  // Held in Firestore so the limit holds across serverless instances.
  const [perIp, perPage] = await Promise.all([
    // When the address can't be read, visitors share a wider bucket instead of locking each other out.
    ip ? hitLimit(`fsb:ip:${ip}:${subAccountId}`, 5, 3_600_000) : hitLimit(`fsb:noip:${subAccountId}`, 40, 3_600_000),
    hitLimit(`fsb:page:${subAccountId}`, 300, 86_400_000),
  ]);
  if (!perIp.ok || !perPage.ok) return tooMany;

  try {
    const res = await submitBookingRequest(subAccountId, body);
    return NextResponse.json(
      {
        ok: true,
        number: res.number,
        statusUrl: res.statusUrl,
        scheduledLabel: res.scheduledLabel ?? null,
        // The page sends the customer to pay when these are set. Without them a deposit booking is never paid.
        depositToken: res.depositToken ?? null,
        depositMinor: res.depositMinor ?? 0,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
