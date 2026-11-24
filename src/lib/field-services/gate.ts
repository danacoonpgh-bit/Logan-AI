import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { NextResponse } from "next/server";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";

type MemberAccess = Exclude<
  Awaited<ReturnType<typeof requireSubAccountMember>>,
  NextResponse
>;

export interface FieldServicesAccess {
  access: MemberAccess;
  sub: SubAccountDoc;
}

async function gateCheck(
  access: MemberAccess,
  subAccountId: string,
): Promise<FieldServicesAccess | NextResponse> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = (snap.data() ?? {}) as SubAccountDoc;
  if (!fieldServicesAvailable(sub)) {
    return NextResponse.json(
      {
        error:
          "Field Services isn't enabled for this workspace. Ask your agency to turn on Labs and then Field Services.",
      },
      { status: 403 },
    );
  }
  return { access, sub };
}

export async function requireFieldServicesMember(
  request: Request,
  subAccountId: string,
): Promise<FieldServicesAccess | NextResponse> {
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  return gateCheck(access, subAccountId);
}

export async function requireFieldServicesAdmin(
  request: Request,
  subAccountId: string,
): Promise<FieldServicesAccess | NextResponse> {
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;
  return gateCheck(access, subAccountId);
}
