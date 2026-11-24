import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { LANDING_VARIANT } from "@/config/landing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Add or remove an extra email on a purchase, for buyers who check out with one
 * address and set up with another. Used for display and matching (Instances
 * join, Purchaser Replies); never for revocation or the mailing audience.
 * Mothership-only, agency owner only.
 *
 * Body: { purchaseId, action: "add" | "remove", email }
 */

const MAX_ALTERNATES = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Body {
  purchaseId?: string;
  action?: string;
  email?: string;
}

export async function POST(request: Request) {
  if (LANDING_VARIANT !== "leadstack") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const owner = await requireAgencyOwnerAny(request);
  if (owner instanceof NextResponse) return owner;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const purchaseId =
    typeof body.purchaseId === "string" ? body.purchaseId.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!purchaseId || purchaseId.includes("/")) {
    return NextResponse.json({ error: "`purchaseId` is required." }, { status: 400 });
  }
  if (body.action !== "add" && body.action !== "remove") {
    return NextResponse.json({ error: "`action` must be add or remove." }, { status: 400 });
  }
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const db = getAdminDb();
  const ref = db.collection("purchases").doc(purchaseId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Purchase not found." }, { status: 404 });
  }
  const data = snap.data() ?? {};
  const current: string[] = Array.isArray(data.alternateEmails)
    ? data.alternateEmails.filter((e: unknown): e is string => typeof e === "string")
    : [];

  if (body.action === "remove") {
    await ref.update({ alternateEmails: FieldValue.arrayRemove(email) });
    return NextResponse.json({
      ok: true,
      alternateEmails: current.filter((e) => e !== email),
    });
  }

  if (email === String(data.email ?? "").trim().toLowerCase()) {
    return NextResponse.json(
      { error: "That is already this buyer's purchase email." },
      { status: 400 },
    );
  }
  if (current.includes(email)) {
    return NextResponse.json({ ok: true, alternateEmails: current });
  }
  if (current.length >= MAX_ALTERNATES) {
    return NextResponse.json(
      { error: `A buyer can have up to ${MAX_ALTERNATES} extra emails.` },
      { status: 400 },
    );
  }

  // One address belongs to one buyer, otherwise instance matching is ambiguous.
  const [asPrimary, asAlternate] = await Promise.all([
    db.collection("purchases").where("email", "==", email).limit(1).get(),
    db
      .collection("purchases")
      .where("alternateEmails", "array-contains", email)
      .limit(1)
      .get(),
  ]);
  if (!asPrimary.empty || !asAlternate.empty) {
    return NextResponse.json(
      { error: "That address already belongs to another buyer." },
      { status: 409 },
    );
  }

  await ref.update({ alternateEmails: FieldValue.arrayUnion(email) });
  return NextResponse.json({ ok: true, alternateEmails: [...current, email] });
}
