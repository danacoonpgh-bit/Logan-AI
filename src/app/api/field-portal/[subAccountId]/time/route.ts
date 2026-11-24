import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { crewTimeAllowed, portalActor } from "@/lib/server/field-portal-access";
import { requireLink } from "@/lib/server/field-portal-session-service";
import { crewTimeAction, crewTimeState } from "@/lib/server/field-crew-time-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{6,80}$/;

export const GET = withFieldPerson<{ subAccountId: string }>(async ({ request, session, params }) => {
  if (!ID.test(params.subAccountId)) return json({ error: "Not found." }, 404);
  const link = await requireLink(session.personId, params.subAccountId);
  if (!link) return json({ error: "Not found." }, 404);
  try {
    const q = new URL(request.url).searchParams;
    return json(
      await crewTimeState({
        subAccountId: link.subAccountId,
        workerId: link.workerId,
        date: q.get("date"),
        includeTargets: q.get("targets") === "1",
      }),
    );
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
});

export const POST = withFieldPerson<{ subAccountId: string }>(async ({ request, session, params }) => {
  if (!ID.test(params.subAccountId)) return json({ error: "Not found." }, 404);
  const link = await requireLink(session.personId, params.subAccountId);
  if (!link) return json({ error: "Not found." }, 404);
  if (!(await crewTimeAllowed(session.personId))) {
    return json({ error: "Too many updates. Wait a few minutes." }, 429);
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ error: "Invalid JSON body" }, 400);
  try {
    const res = await crewTimeAction({
      subAccountId: link.subAccountId,
      actor: portalActor(session.personId, link),
      body,
    });
    return json(res);
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
});
