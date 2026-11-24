import { notFound } from "next/navigation";
import { getAdminDb } from "@/lib/firebase/admin";
import { PublicBookingView } from "@/components/booking/public-booking-view";
import { effectiveBookingLocation } from "@/lib/booking/location";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Public booking page. Server-rendered with the Admin SDK so the page and
 * sub-account docs can stay member-only in rules. Missing and draft pages
 * both 404 so unpublished pages don't leak. The picker and intake form are
 * a client component (PublicBookingView) that talks to the public
 * /api/booking/[saId]/[slug]/* routes.
 */

interface PageProps {
  params: Promise<{ subAccountId: string; slug: string }>;
}

export default async function PublicBookingPage({ params }: PageProps) {
  const { subAccountId, slug } = await params;
  const db = getAdminDb();

  const [pageSnap, subSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}/bookingPages/${slug}`).get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  if (!pageSnap.exists || !subSnap.exists) notFound();

  const page = pageSnap.data() as BookingPage;
  if (page.status !== "published") notFound();

  const sub = subSnap.data() as SubAccountDoc;

  // Page overrides, then sub-account, then fallback. Must be plain JSON to
  // cross to the client.
  const branding = {
    name: sub.name ?? "Schedule a meeting",
    logoUrl: page.logoUrl ?? sub.logoUrl ?? null,
    accentColor: page.accentColor ?? null,
  };

  // The meeting link is a paid-for secret, so it must never reach the client.
  // Resolve the location first so pages that only had a link still read as video.
  const pageForClient: Omit<BookingPage, "createdAt" | "updatedAt"> & {
    createdAt: null;
    updatedAt: null;
  } = {
    ...page,
    location: effectiveBookingLocation(page),
    meetingUrl: null,
    createdAt: null,
    updatedAt: null,
  };

  return (
    <PublicBookingView
      subAccountId={subAccountId}
      page={pageForClient}
      branding={branding}
    />
  );
}
