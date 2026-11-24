import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";

/**
 * Community staff routes (courses, lessons, member approval, mark paid): any
 * active member of the sub-account plus the agency's Community gate. Group
 * settings and a course's access or price need an admin; routes check
 * `isAdmin` for those. Returns the access context (with `agencyId` for
 * writes) or a NextResponse.
 */
export async function requireCommunityStaff(
  request: Request,
  subAccountId: string,
) {
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = subSnap.data();
  if (sub?.communityEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Community is disabled for this sub-account." },
      { status: 403 },
    );
  }
  return {
    ...access,
    isAdmin:
      access.subAccountRole === "admin" ||
      access.subAccountRole === "agencyOwner",
    resolvedAgencyId: (sub.agencyId as string) ?? access.agencyId ?? "",
  };
}

export const COURSE_ACCESS_ADMIN_ONLY =
  "Only an admin can set a course's access or price.";
