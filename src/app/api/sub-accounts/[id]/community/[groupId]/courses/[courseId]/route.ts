import "server-only";

import { NextResponse } from "next/server";
import { COURSE_ACCESS_ADMIN_ONLY, requireCommunityStaff } from "@/lib/community/staff-guard";
import {
  deleteCourseServerSide,
  getCourseAccess,
  updateCourseServerSide,
  type CoursePatch,
} from "@/lib/server/community-classroom-service";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; groupId: string; courseId: string }> },
) {
  const { id: subAccountId, groupId, courseId } = await ctx.params;
  const access = await requireCommunityStaff(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let patch: CoursePatch;
  try {
    patch = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!access.isAdmin) {
    // Forms send the access fields back unchanged, so only a real change is refused.
    const current = await getCourseAccess({ subAccountId, groupId, courseId });
    if (!current) {
      return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }
    // A level only counts on a level course and a price only on a purchase one.
    const changed =
      (patch.access !== undefined && patch.access !== current.access) ||
      (current.access === "level" &&
        patch.requiredLevel !== undefined &&
        patch.requiredLevel !== (current.requiredLevel ?? 2)) ||
      (current.access === "purchase" &&
        ((patch.priceCents !== undefined && patch.priceCents !== current.priceCents) ||
          (patch.currency !== undefined && patch.currency !== current.currency)));
    if (changed) {
      return NextResponse.json({ error: COURSE_ACCESS_ADMIN_ONLY }, { status: 403 });
    }
    delete patch.access;
    delete patch.requiredLevel;
    delete patch.priceCents;
    delete patch.currency;
  }
  await updateCourseServerSide({ subAccountId, groupId, courseId, patch });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; groupId: string; courseId: string }> },
) {
  const { id: subAccountId, groupId, courseId } = await ctx.params;
  const access = await requireCommunityStaff(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (!access.isAdmin) {
    // Deleting a locked or paid course and making an open copy would get round the access rule.
    const current = await getCourseAccess({ subAccountId, groupId, courseId });
    if (current && current.access !== "open") {
      return NextResponse.json(
        { error: "Only an admin can delete a course that is level-locked or paid." },
        { status: 403 },
      );
    }
  }
  await deleteCourseServerSide({ subAccountId, groupId, courseId });
  return NextResponse.json({ ok: true });
}
