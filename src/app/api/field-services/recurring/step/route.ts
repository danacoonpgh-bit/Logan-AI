import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { runRecurringSweep } from "@/lib/server/field-recurrence-service";

export const maxDuration = 300;

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    return NextResponse.json({ ok: true, ...(await runRecurringSweep()) });
  } catch (err) {
    console.error("[field-recurrence] sweep failed", err);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
