import "server-only";

import { NextResponse } from "next/server";
import { fieldServicesAvailable } from "@/lib/field-services/availability";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendVisitMessage } from "@/lib/server/field-messages-service";

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: { visitId?: string; version?: number };
  try {
    body = JSON.parse(rawBody) as { visitId?: string; version?: number };
  } catch {
    return NextResponse.json({ ok: true, skipped: "bad_body" });
  }
  if (!body.visitId) return NextResponse.json({ ok: true, skipped: "no_visit" });

  // Check the gate before claiming, so a reminder skipped while off is still sent after it is turned back on.
  const ref = getAdminDb().doc(`visits/${body.visitId}`);
  const visitSnap = await ref.get();
  const subId = visitSnap.data()?.subAccountId as string | undefined;
  if (!subId) return NextResponse.json({ ok: true, skipped: "stale" });
  const subSnap = await getAdminDb().doc(`subAccounts/${subId}`).get();
  if (!fieldServicesAvailable(subSnap.data())) return NextResponse.json({ ok: true, skipped: "disabled" });

  // Claim this version so a redelivered callback sends only once.
  const claimed = await getAdminDb().runTransaction(async (tx) => {
    const visit = (await tx.get(ref)).data();
    if (
      !visit ||
      visit.status !== "pending" ||
      visit.reminderVersion !== body.version ||
      visit.reminderSentVersion === body.version
    ) {
      return false;
    }
    tx.update(ref, { reminderSentVersion: body.version });
    return true;
  });
  if (!claimed) return NextResponse.json({ ok: true, skipped: "stale" });
  await sendVisitMessage("reminder", body.visitId);
  return NextResponse.json({ ok: true });
}
