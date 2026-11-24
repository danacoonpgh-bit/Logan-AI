import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { getAdminDb } from "@/lib/firebase/admin";
import { listInternalJobs } from "@/lib/server/field-internal-jobs-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

const MAX_JOBS = 300;
const OPEN = ["unscheduled", "scheduled", "in_progress", "ready_to_invoice", "action_required"];

/** The projects and internal projects the office can move a time entry to. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    const [jobSnap, internal] = await Promise.all([
      getAdminDb()
        .collection("jobs")
        .where("subAccountId", "==", subAccountId)
        .where("status", "in", OPEN)
        .limit(MAX_JOBS)
        .get(),
      listInternalJobs(subAccountId),
    ]);
    const jobs = jobSnap.docs
      .map((d) => ({
        id: d.id,
        number: String(d.data().number ?? ""),
        title: String(d.data().title ?? ""),
        hoursOnly: d.data().hoursOnly === true,
      }))
      .sort((a, b) => b.number.localeCompare(a.number));
    const res = NextResponse.json({
      jobs,
      internalJobs: internal.filter((j) => !j.archived).map((j) => ({ id: j.id, name: j.name })),
    });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
