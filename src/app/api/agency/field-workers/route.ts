import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { listAgencyCrew } from "@/lib/server/field-crew-admin-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const rows = await listAgencyCrew(caller.agencyId!);
  return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
}
