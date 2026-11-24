import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { requireOffice } from "@/lib/field-services/route-helpers";
import { applyBalance, balanceDay } from "@/lib/server/field-balance-service";
import { applyDayPlan, planDay } from "@/lib/server/field-day-plan-service";
import { applyRoute, routeReadiness, suggestRoute } from "@/lib/server/field-route-service";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

/** Whether route suggestions are on, and the setup checks that decide whether they can be. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const notOffice = await requireOffice(guard);
  if (notOffice) return notOffice;
  try {
    const [config, readiness] = await Promise.all([getFieldServicesConfig(subAccountId), routeReadiness(subAccountId)]);
    return NextResponse.json({ enabled: config.routeSuggestionsEnabled === true, leadDays: config.routeLeadDays, maxDays: config.routeMaxDays ?? 7, awareSlots: config.routeAwareSlots === true, returnToBase: config.routeReturnToBase === true, readiness });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

/** Suggests a driving order for one person's day, or applies it when `apply` is true. */
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
  const workerId = typeof body.workerId === "string" ? body.workerId : "";
  const day = typeof body.day === "string" ? body.day : "";
  if (body.balance === true) {
    try {
      if (body.apply === true) {
        const list = Array.isArray(body.assignments) ? body.assignments : [];
        const expected = list
          .filter((a): a is { visitId: string; workerId: string } => !!a && typeof a.visitId === "string" && typeof a.workerId === "string")
          .map((a) => ({ visitId: a.visitId, workerId: a.workerId }));
        return NextResponse.json(await applyBalance(subAccountId, day, expected));
      }
      return NextResponse.json(await balanceDay(subAccountId, day));
    } catch (err) {
      return fieldServicesErrorResponse(err);
    }
  }
  if (body.plan === true) {
    try {
      if (body.apply === true) {
        const list = Array.isArray(body.assignments) ? body.assignments : [];
        const expected = list
          .filter((a): a is { visitId: string; workerId: string } => !!a && typeof a.visitId === "string" && typeof a.workerId === "string")
          .map((a) => ({ visitId: a.visitId, workerId: a.workerId }));
        return NextResponse.json(await applyDayPlan(subAccountId, day, expected));
      }
      return NextResponse.json(await planDay(subAccountId, day));
    } catch (err) {
      return fieldServicesErrorResponse(err);
    }
  }
  if (!workerId) return NextResponse.json({ error: "Choose a staff member." }, { status: 400 });
  try {
    if (body.apply === true) {
      const order = Array.isArray(body.order) ? body.order.filter((x): x is string => typeof x === "string") : [];
      return NextResponse.json(await applyRoute(subAccountId, workerId, day, order));
    }
    return NextResponse.json(await suggestRoute(subAccountId, workerId, day));
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
