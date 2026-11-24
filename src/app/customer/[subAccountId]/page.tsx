import type { Metadata } from "next";
import { requirePortalOpen } from "@/lib/server/field-customer-auth-service";
import { CustomerPortal } from "@/components/field-customer/customer-portal";
import { PublicFrame } from "@/components/field-booking/public-frame";
import { loadPublicBookingConfig, publicLook } from "@/lib/server/field-booking-service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your requests",
  robots: { index: false, follow: false },
};

export default async function CustomerPortalPage({ params }: { params: Promise<{ subAccountId: string }> }) {
  const { subAccountId } = await params;
  let name = "";
  let open = false;
  let look: ReturnType<typeof publicLook> = {
    theme: "light",
    style: "default",
    logoUrl: null,
    contact: { email: null, phone: null },
  };
  let accent = "";
  try {
    const { sub, config } = await requirePortalOpen(subAccountId);
    name = config.portalName || sub.name || "Your account";
    look = publicLook(sub, config);
    accent = config.bookingAccent ?? "";
    open = true;
  } catch {
    open = false;
  }
  const bookable = open ? (await loadPublicBookingConfig(subAccountId)) !== null : false;

  return (
    <PublicFrame theme={look.theme} accent={accent} style={look.style}>
      {open ? (
        <CustomerPortal
          subAccountId={subAccountId}
          businessName={name}
          logoUrl={look.logoUrl}
          contact={look.contact}
          bookingHref={bookable ? `/book-service/${subAccountId}` : null}
        />
      ) : (
        <div className="mt-16 rounded-2xl border bg-card p-8 text-center">
          <h1 className="text-xl font-semibold">This page isn&apos;t available</h1>
          <p className="mt-2 text-sm text-muted-foreground">Please contact the business directly.</p>
        </div>
      )}
    </PublicFrame>
  );
}
