import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { WORKSPACE_ID } from "@/lib/field-portal/identity";
import { fieldServicesAvailable } from "@/lib/field-services/availability";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { getPwaIconVersion } from "@/lib/pwa/icons-server";
import { ICON_STATIC_FALLBACKS } from "@/lib/pwa/icon-variants";
import { LANDING_VARIANT } from "@/config/landing";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ subAccountId: string }> }) {
  const { subAccountId } = await params;
  if (!WORKSPACE_ID.test(subAccountId)) return new NextResponse(null, { status: 404 });
  const sub = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data();
  const business = sub && fieldServicesAvailable(sub) && typeof sub.name === "string" ? sub.name : "";
  const [brand, iconVersion] = await Promise.all([
    LANDING_VARIANT === "custom" ? resolveCustomBrand() : Promise.resolve(null),
    getPwaIconVersion(),
  ]);
  const base = business || brand?.name || "LeadStack";
  const v = iconVersion ? `?v=${iconVersion}` : "";
  const icons = iconVersion
    ? [
        { src: `/api/pwa/icon/192${v}`, sizes: "192x192", type: "image/png" },
        { src: `/api/pwa/icon/512${v}`, sizes: "512x512", type: "image/png" },
        { src: `/api/pwa/icon/maskable${v}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
      ]
    : [
        { src: ICON_STATIC_FALLBACKS["192"], sizes: "192x192", type: "image/png" },
        { src: ICON_STATIC_FALLBACKS["512"], sizes: "512x512", type: "image/png" },
        { src: ICON_STATIC_FALLBACKS.maskable, sizes: "512x512", type: "image/png", purpose: "maskable" },
      ];

  return NextResponse.json(
    {
      name: `${base} Field`,
      short_name: base.slice(0, 12) || "Field",
      description: "Your jobs for the day.",
      id: `/field/${subAccountId}`,
      start_url: `/field/${subAccountId}`,
      scope: `/field/${subAccountId}`,
      display: "standalone",
      orientation: "portrait",
      background_color: "#18181b",
      theme_color: "#18181b",
      icons,
    },
    {
      headers: {
        "Content-Type": "application/manifest+json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
