import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { portalAccess } from "@/lib/server/field-portal-access";
import { deleteVisitPhoto, signedPhotoUrl } from "@/lib/server/field-photos-service";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";

export const dynamic = "force-dynamic";

type P = { subAccountId: string; visitId: string; photoId: string };

export const GET = withFieldPerson<P>(async ({ request, session, params }) => {
  const access = await portalAccess({ session }, params.subAccountId, "visits", params.visitId);
  if (access instanceof Response) return access;
  if (!access.link.canHandlePrices) {
    const visit = (await getAdminDb().doc(`visits/${params.visitId}`).get()).data();
    const photo = (visit?.photos as { id: string; label: string; byWorkerId?: string }[] | undefined)?.find(
      (p) => p.id === params.photoId,
    );
    if (photo?.label === "receipt" && photo.byWorkerId !== access.link.workerId) {
      return json({ error: "Not found." }, 404);
    }
  }
  try {
    const url = await signedPhotoUrl({
      subAccountId: params.subAccountId,
      visitId: params.visitId,
      photoId: params.photoId,
      thumb: new URL(request.url).searchParams.get("size") === "thumb",
    });
    return NextResponse.redirect(url, 302);
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
});

export const DELETE = withFieldPerson<P>(async ({ session, params }) => {
  const access = await portalAccess({ session }, params.subAccountId, "visits", params.visitId);
  if (access instanceof Response) return access;
  try {
    await deleteVisitPhoto({
      subAccountId: params.subAccountId,
      visitId: params.visitId,
      photoId: params.photoId,
      actor: access.actor,
    });
    return json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
});
