import { redirect } from "next/navigation";
import { currentSession } from "@/lib/field-portal/guard";
import { FieldHome } from "@/components/field-portal/field-home";
import { BrandCookieWriter } from "@/components/field-portal/brand-cookie-writer";
import { getAdminDb } from "@/lib/firebase/admin";
import { fieldServicesAvailable } from "@/lib/field-services/availability";

export const dynamic = "force-dynamic";

export default async function FieldHomePage({ params }: { params: Promise<{ subAccountId: string }> }) {
  const { subAccountId } = await params;
  const [session, subSnap] = await Promise.all([
    currentSession(subAccountId),
    getAdminDb().doc(`subAccounts/${subAccountId}`).get(),
  ]);
  if (!session) redirect(`/field/${subAccountId}/login`);
  const sub = subSnap.data();
  const name = sub && fieldServicesAvailable(sub) && typeof sub.name === "string" ? sub.name : "";
  const logoUrl = sub && typeof sub.logoUrl === "string" ? sub.logoUrl : null;
  return (
    <>
      <BrandCookieWriter subAccountId={subAccountId} name={name} logoUrl={logoUrl} />
      <FieldHome subAccountId={subAccountId} brandName={name} />
    </>
  );
}
