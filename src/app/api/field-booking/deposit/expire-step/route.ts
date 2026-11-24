import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { expireDepositBooking } from "@/lib/server/field-booking-deposit-service";

export const dynamic = "force-dynamic";

/** Queue callback: gives a held time back when its deposit was not paid. */
export async function POST(request: Request) {
  const signature = request.headers.get("Upstash-Signature");
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const raw = await request.text();
  if (!(await verifyQStashSignature(signature, raw))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let quoteId = "";
  try {
    quoteId = String((JSON.parse(raw) as { quoteId?: unknown }).quoteId ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(quoteId)) return NextResponse.json({ error: "quoteId required" }, { status: 400 });
  try {
    await expireDepositBooking(quoteId);
  } catch (err) {
    console.error("[field-booking] deposit expiry failed", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
