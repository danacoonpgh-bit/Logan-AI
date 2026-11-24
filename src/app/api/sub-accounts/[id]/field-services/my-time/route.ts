import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import { workerForUid, type FieldActor } from "@/lib/server/field-access";
import { crewTimeAction, crewTimeState } from "@/lib/server/field-crew-time-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { hitLimit } from "@/lib/server/field-rate-limit";

export const dynamic = "force-dynamic";

/** A staff member who is also a worker logs time as that worker, with a worker's permissions even if they are an admin. */
async function asWorker(request: Request, subAccountId: string) {
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const workerId = await workerForUid(subAccountId, guard.access.uid);
  if (!workerId) {
    return NextResponse.json({ error: "You don't have a worker profile in this workspace." }, { status: 403 });
  }
  const actor: FieldActor = { uid: guard.access.uid, isOffice: false, workerId };
  return { actor, workerId };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const ctx = await asWorker(request, subAccountId);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const q = new URL(request.url).searchParams;
    const res = NextResponse.json(
      await crewTimeState({
        subAccountId,
        workerId: ctx.workerId,
        date: q.get("date"),
        includeTargets: q.get("targets") === "1",
      }),
    );
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const ctx = await asWorker(request, subAccountId);
  if (ctx instanceof NextResponse) return ctx;
  if (!(await hitLimit(`staff:time:${ctx.workerId}`, 240, 3_600_000)).ok) {
    return NextResponse.json({ error: "Too many updates. Wait a few minutes." }, { status: 429 });
  }
  const body = await readJson(request);
  if (!body) return badJson();
  try {
    return NextResponse.json(await crewTimeAction({ subAccountId, actor: ctx.actor, body }));
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
