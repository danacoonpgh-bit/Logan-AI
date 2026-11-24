import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { crewRoute } from "@/lib/server/field-route-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

/** The signed-in person's own visits for one day, as map stops. */
export const GET = withFieldPerson(async ({ request, session }) => {
  const day = new URL(request.url).searchParams.get("day") ?? "";
  try {
    return json(await crewRoute(session.personId, day));
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
});
