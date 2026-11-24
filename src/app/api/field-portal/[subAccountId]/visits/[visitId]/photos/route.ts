import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { portalAccess } from "@/lib/server/field-portal-access";
import { uploadVisitPhoto } from "@/lib/server/field-photos-service";
import {
  FieldServicesError,
  fieldServicesErrorResponse,
} from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

export const POST = withFieldPerson<{ subAccountId: string; visitId: string }>(
  async ({ request, session, params }) => {
    const access = await portalAccess({ session }, params.subAccountId, "visits", params.visitId);
    if (access instanceof Response) return access;
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
        subAccountId: params.subAccountId,
        visitId: params.visitId,
        actor: access.actor,
        photo: Buffer.from(await photo.arrayBuffer()),
        thumb: thumb instanceof File ? Buffer.from(await thumb.arrayBuffer()) : null,
        label: String(form.get("label") ?? "other"),
        note: String(form.get("note") ?? ""),
      });
      return json(res, 201);
    } catch (err) {
      return fieldServicesErrorResponse(err);
    }
  },
);
