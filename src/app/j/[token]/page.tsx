import { headers } from "next/headers";
import { CustomerStatus } from "@/components/field-services/customer-status";
import { PublicFrame } from "@/components/field-booking/public-frame";
import { portalClientIp } from "@/lib/field-portal/guard";
import { loadStatusPage, loadStatusTerms } from "@/lib/server/field-status-page-service";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return { title: `Your ${(await loadStatusTerms(token)).job}` };
}

export default async function JobStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const ip = portalClientIp(new Request("http://local", { headers: h }));
  const data = await loadStatusPage(token, ip);

  if (!data) {
    const terms = await loadStatusTerms(token);
    return (
      <PublicFrame theme="light" accent="">
        <main className="mt-16 rounded-2xl border bg-card p-8 text-center">
          <h1 className="text-xl font-semibold">This link isn&apos;t working</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            It may have been replaced by a newer one, or the {terms.job} is finished. Check your latest message
            from the business, or contact them directly.
          </p>
        </main>
      </PublicFrame>
    );
  }
  return (
    <PublicFrame theme={data.look.theme} accent={data.look.accent} style={data.look.style}>
      <CustomerStatus token={token} data={data} />
    </PublicFrame>
  );
}
