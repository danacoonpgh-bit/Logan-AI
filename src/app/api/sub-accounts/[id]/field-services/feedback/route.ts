import { NextResponse } from "next/server";
import { requireFieldServicesMember } from "@/lib/field-services/gate";
import { feedbackAnswered, submitFieldFeedback } from "@/lib/server/field-feedback-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json({ answered: await feedbackAnswered(subAccountId) });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await params;
  const guard = await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const body = (await request.json().catch(() => null)) as
    | { helpful?: unknown; text?: unknown; source?: unknown }
    | null;
  try {
    await submitFieldFeedback({
      agencyId: guard.sub.agencyId,
      subAccountId,
      uid: guard.access.uid,
      role: guard.access.subAccountRole,
      helpful: body?.helpful,
      text: body?.text,
      source: body?.source,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
