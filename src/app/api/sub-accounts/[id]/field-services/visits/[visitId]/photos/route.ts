import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import {
  FieldServicesError,
  fieldServicesErrorResponse,
} from "@/lib/server/field-services-errors";
import { uploadVisitPhoto } from "@/lib/server/field-photos-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; visitId: string }> },
) {
  const { id: subAccountId, visitId } = await params;
  const ctx = await docContext(request, subAccountId, "visits", visitId);
  if (ctx instanceof NextResponse) return ctx;

  try {
    if (Number(request.headers.get("content-length") ?? 0) > 8 * 1024 * 1024) {
      throw new FieldServicesError("That upload is too large.", 413);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new FieldServicesError("Send the photo as form data.");
    }
    const photo = form.get("photo");
    if (!(photo instanceof File)) throw new FieldServicesError("No photo was sent.");
    const thumb = form.get("thumb");
    const res = await uploadVisitPhoto({
      subAccountId,
      visitId,
      actor: ctx.actor,
      photo: Buffer.from(await photo.arrayBuffer()),
      thumb: thumb instanceof File ? Buffer.from(await thumb.arrayBuffer()) : null,
      label: String(form.get("label") ?? "other"),
      note: String(form.get("note") ?? ""),
    });
    return NextResponse.json(res, { status: 201 });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
