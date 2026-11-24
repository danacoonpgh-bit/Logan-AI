import type { Metadata } from "next";
import { BookingPageView } from "@/components/field-booking/booking-page-view";
import { loadPublicBookingConfig } from "@/lib/server/field-booking-service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Book a service",
  robots: { index: false, follow: false },
};

export default async function BookServicePage({ params }: { params: Promise<{ subAccountId: string }> }) {
  const { subAccountId } = await params;
  const config = await loadPublicBookingConfig(subAccountId);
  return <BookingPageView subAccountId={subAccountId} config={config} />;
}
