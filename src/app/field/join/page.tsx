import { JoinForm } from "@/components/field-portal/join-form";
import { PublicBrand, PublicCard } from "@/components/field-booking/public-frame";

export const dynamic = "force-dynamic";

export default function FieldJoinPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 p-4">
      <PublicBrand name="Field" logoUrl={null} subtitle="Crew app" />
      <PublicCard>
        <JoinForm />
      </PublicCard>
    </main>
  );
}
