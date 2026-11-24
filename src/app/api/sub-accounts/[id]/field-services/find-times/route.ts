import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { requireOffice } from "@/lib/field-services/route-helpers";
import { findTimes } from "@/lib/server/field-find-times";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

/** Open times for a visit, with the best fit by driving and the earliest. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const notOffice = await requireOffice(guard);
  if (notOffice) return notOffice;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await findTimes(subAccountId, {
        jobId: typeof body.jobId === "string" ? body.jobId : undefined,
        workerIds: Array.isArray(body.workerIds) ? body.workerIds.filter((x): x is string => typeof x === "string") : [],
        minutes: typeof body.minutes === "number" ? body.minutes : undefined,
        from: typeof body.from === "string" ? body.from : "",
        days: typeof body.days === "number" ? body.days : undefined,
        window: typeof body.window === "string" ? body.window : undefined,
        ignoreVisitId: typeof body.ignoreVisitId === "string" ? body.ignoreVisitId : undefined,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
