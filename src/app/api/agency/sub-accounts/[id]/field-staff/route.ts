import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { fieldServicesAvailable } from "@/lib/field-services/availability";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { ownerIsStaff, setOwnerStaff } from "@/lib/server/field-workers-service";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

async function guard(request: Request, subAccountId: string) {
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (access.subAccountRole !== "agencyOwner") {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  return { access, sub: snap.data() as SubAccountDoc };
}

/** Whether the signed-in agency owner is on this workspace's field staff. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await guard(request, id);
  if (g instanceof NextResponse) return g;
  return NextResponse.json({ isStaff: await ownerIsStaff(id, g.access.uid) });
}

/** Body { on: boolean }: adds the agency owner to this workspace's field staff, or takes them off. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await guard(request, id);
  if (g instanceof NextResponse) return g;
  if (!fieldServicesAvailable(g.sub)) {
    return NextResponse.json({ error: "Turn on Labs and Field Services for this sub-account first." }, { status: 409 });
  }
  let body: { on?: unknown };
  try {
    body = (await request.json()) as { on?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.on !== "boolean") return NextResponse.json({ error: "Say whether to add or remove." }, { status: 400 });
  try {
    await setOwnerStaff({ agencyId: g.sub.agencyId, subAccountId: id, ownerUid: g.access.uid, on: body.on });
    return NextResponse.json({ isStaff: body.on });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
