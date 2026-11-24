import { NextResponse } from "next/server";
import { docContext } from "@/lib/field-services/route-helpers";
import { fieldServicesErrorResponse } from "@/lib/server/field-services-errors";
import { deleteVisitPhoto, signedPhotoUrl } from "@/lib/server/field-photos-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; visitId: string; photoId: string }> },
) {
  const { id: subAccountId, visitId, photoId } = await params;
  const ctx = await docContext(request, subAccountId, "visits", visitId);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const url = await signedPhotoUrl({
      subAccountId,
      visitId,
      photoId,
      thumb: new URL(request.url).searchParams.get("size") === "thumb",
    });
    const res = NextResponse.redirect(url, 302);
    res.headers.set("Cache-Control", "private, max-age=300");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; visitId: string; photoId: string }> },
) {
  const { id: subAccountId, visitId, photoId } = await params;
  const ctx = await docContext(request, subAccountId, "visits", visitId);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await deleteVisitPhoto({ subAccountId, visitId, photoId, actor: ctx.actor });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fieldServicesErrorResponse(err);
  }
}
