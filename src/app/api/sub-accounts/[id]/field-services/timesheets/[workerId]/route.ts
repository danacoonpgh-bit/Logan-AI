import { NextResponse } from "next/server";
import { requireFieldServicesAdmin } from "@/lib/field-services/gate";
import { isDayKey, mondayOf } from "@/lib/field-services/intervals";
import { badJson, readJson } from "@/lib/field-services/route-helpers";
import { crewTimeState, parseTarget } from "@/lib/server/field-crew-time-service";
import { requireTerritoryOfDoc } from "@/lib/field-services/territory";
import { addHoursOnTarget, addTimeOnTarget } from "@/lib/server/field-time-service";
import { fieldServicesErrorResponse, FieldServicesError } from "@/lib/server/field-services-errors";
import {
  approveWeek,
  requireWorkerInWorkspace,
  sendBackWeek,
  unlockWeek,
} from "@/lib/server/field-timesheet-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; workerId: string }> },
) {
  const { id: subAccountId, workerId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  try {
    const worker = await requireWorkerInWorkspace(subAccountId, workerId);
    const week = new URL(request.url).searchParams.get("week");
    const state = await crewTimeState({
      subAccountId,
      workerId,
      date: isDayKey(week) ? mondayOf(week) : null,
      includeWeekEntries: true,
    });
    const res = NextResponse.json({ worker: { id: workerId, name: worker.name }, state });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; workerId: string }> },
) {
  const { id: subAccountId, workerId } = await params;
  const guard = await requireFieldServicesAdmin(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = await readJson(request);
  if (!body) return badJson();
  const byUid = guard.access.uid;
  try {
    switch (body.action) {
      case "approve":
        await approveWeek({ subAccountId, workerId, weekStart: body.weekStart, byUid });
        break;
      case "send_back":
        await sendBackWeek({ subAccountId, workerId, weekStart: body.weekStart, byUid, note: body.note });
        break;
      case "unlock":
        await unlockWeek({ subAccountId, workerId, weekStart: body.weekStart, byUid, note: body.note });
        break;
      case "add_time": {
        // The office adds time for a worker: hours for an hours-only project, a start and end otherwise.
        await requireWorkerInWorkspace(subAccountId, workerId);
        const target = parseTarget(body.target);
        if (target.type === "visit") throw new FieldServicesError("Choose a project, an internal project or general time.");
        if (target.type === "job") {
          const outOfScope = await requireTerritoryOfDoc(guard, "jobs", target.jobId);
          if (outOfScope) return outOfScope;
        }
        const actor = { uid: byUid, isOffice: true, workerId: null };
        const common = {
          subAccountId,
          actor,
          workerId,
          target,
          note: typeof body.note === "string" ? body.note : undefined,
          reason: typeof body.reason === "string" ? body.reason : "",
        };
        const res =
          body.minutes !== undefined
            ? await addHoursOnTarget({ ...common, date: body.date, minutes: body.minutes })
            : await addTimeOnTarget({ ...common, startAt: body.startAt, endAt: body.endAt });
        return NextResponse.json({ ok: true, warnings: res.warnings });
      }
      default:
        throw new FieldServicesError("Unknown action.");
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
