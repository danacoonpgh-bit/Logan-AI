import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PublicBrand, PublicCard } from "@/components/field-booking/public-frame";
import { WORKSPACE_ID } from "@/lib/field-portal/identity";

export const dynamic = "force-dynamic";

const COOKIE_PREFIX = process.env.NODE_ENV === "production" ? "__Host-ls_field_" : "ls_field_";

/** The crew app lives at an address for one business. A phone with one business signed in goes straight there. */
export default async function FieldIndexPage() {
  const jar = await cookies();
  const mine = jar
    .getAll()
    .map((c) => (c.name.startsWith(COOKIE_PREFIX) ? c.name.slice(COOKIE_PREFIX.length) : ""))
    .filter((id) => WORKSPACE_ID.test(id));
  if (mine.length === 1) redirect(`/field/${mine[0]}`);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 p-4">
      <PublicBrand name="Field" logoUrl={null} subtitle="Crew app" />
      <PublicCard>
        <h1 className="text-2xl font-semibold">Open your crew app link</h1>
        <p className="mt-2 text-base text-muted-foreground">
          Each business has its own crew app. Use the link in the email your employer sent you, or ask them for it.
        </p>
      </PublicCard>
    </main>
  );
}
