import "server-only";

import { NextResponse } from "next/server";
import { portalClientIp, sameOrigin } from "@/lib/field-portal/guard";
import { respondToApproval } from "@/lib/server/field-approvals-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string; approvalId: string }> },
) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { token, approvalId } = await params;
  const body = (await request.json().catch(() => null)) as
    | { decision?: unknown; name?: unknown; comment?: unknown }
    | null;
  const result = await respondToApproval({
    token,
    approvalId,
    decision: body?.decision,
    name: body?.name,
    comment: body?.comment,
    ip: portalClientIp(request),
    userAgent: request.headers.get("user-agent") ?? "",
  });
  const headers = { "Cache-Control": "no-store" };
  if (result === "limited") {
    return NextResponse.json({ error: "Too many tries. Please wait a few minutes." }, { status: 429, headers });
  }
  if (result === "answered") {
    return NextResponse.json({ error: "This request has already been answered." }, { status: 409, headers });
  }
  if (result === "invalid") {
    return NextResponse.json({ error: "That didn't work. Check the details and try again." }, { status: 400, headers });
  }
  return NextResponse.json({ ok: true }, { headers });
}
