import { LoginForm } from "@/components/field-portal/login-form";
import { BrandCookieWriter } from "@/components/field-portal/brand-cookie-writer";
import { PublicBrand, PublicCard } from "@/components/field-booking/public-frame";
import { getAdminDb } from "@/lib/firebase/admin";
import { WORKSPACE_ID } from "@/lib/field-portal/identity";
import { fieldServicesAvailable } from "@/lib/field-services/availability";

export const dynamic = "force-dynamic";

export default async function FieldLoginPage({ params }: { params: Promise<{ subAccountId: string }> }) {
  const { subAccountId } = await params;
  let name = "Field";
  let known = false;
  let logoUrl: string | null = null;
  if (WORKSPACE_ID.test(subAccountId)) {
    const sub = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data();
    if (sub && fieldServicesAvailable(sub) && typeof sub.name === "string" && sub.name) {
      name = sub.name;
      known = true;
      logoUrl = typeof sub.logoUrl === "string" ? sub.logoUrl : null;
    }
  }
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 p-4">
      {known && <BrandCookieWriter subAccountId={subAccountId} name={name} logoUrl={logoUrl} />}
      <PublicBrand name={name} logoUrl={null} subtitle="Crew app" />
      <PublicCard>
        <LoginForm subAccountId={subAccountId} />
      </PublicCard>
    </main>
  );
}
