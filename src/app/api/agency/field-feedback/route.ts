import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { agencyFieldFeedback, agencyFieldUsage } from "@/lib/server/field-feedback-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const [feedback, usage] = await Promise.all([
    agencyFieldFeedback(caller.agencyId!),
    agencyFieldUsage(caller.agencyId!),
  ]);
  return NextResponse.json({ feedback, usage }, { headers: { "Cache-Control": "no-store" } });
}
