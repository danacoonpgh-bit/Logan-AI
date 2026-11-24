import "server-only";

import { NextResponse } from "next/server";
import { portalClientIp, sameOrigin } from "@/lib/field-portal/guard";
import { respondToSignoff } from "@/lib/server/field-signoff-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string; signoffId: string }> },
) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { token, signoffId } = await params;
  const body = (await request.json().catch(() => null)) as { name?: unknown; comment?: unknown } | null;
  const result = await respondToSignoff({
    token,
    signoffId,
    name: body?.name,
    comment: body?.comment,
    ip: portalClientIp(request),
    userAgent: request.headers.get("user-agent") ?? "",
  });
  const headers = { "Cache-Control": "no-store" };
  if (result === "limited") {
    return NextResponse.json({ error: "Too many tries. Please wait a few minutes." }, { status: 429, headers });
  }
  if (result === "expired") {
    return NextResponse.json(
      { error: "This request was replaced or is no longer open. Please use the latest message from the business." },
      { status: 409, headers },
    );
  }
  if (result === "notready") {
    return NextResponse.json(
      { error: "The work isn't marked finished yet. Please try again in a little while." },
      { status: 409, headers },
    );
  }
  if (result === "answered") {
    return NextResponse.json({ error: "This has already been confirmed." }, { status: 409, headers });
  }
  if (result === "invalid") {
    return NextResponse.json({ error: "That didn't work. Check your name and try again." }, { status: 400, headers });
  }
  return NextResponse.json({ ok: true }, { headers });
}
