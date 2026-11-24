"use client";

import { useState } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import {
  CustomerPortalCard,
  OnlineBookingCard,
  PagePreviewCard,
  PublicLookCard,
  SiteBookingCard,
} from "@/components/field-services/online-booking-card";

function Layout({
  page,
  children,
}: {
  page: "book-service" | "book-service-site" | "customer";
  children: React.ReactNode;
}) {
  const { isAdmin } = useSubAccount();
  if (!isAdmin) {
    return (
      <section className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        Only admins can change these settings.
      </section>
    );
  }
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
      <div className="min-w-0 space-y-6">{children}</div>
      <div className="min-w-0 xl:sticky xl:top-4">
        <PagePreviewCard page={page} />
      </div>
    </div>
  );
}

type BookingView = "standard" | "site";

/** The standard booking page, and the one a website build made, each with a live preview beside it. */
export function OnlineBookingTab() {
  const [view, setView] = useState<BookingView>("standard");
  const tabs: { id: BookingView; label: string }[] = [
    { id: "standard", label: "Booking page" },
    { id: "site", label: "Website booking page" },
  ];
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b" role="tablist" aria-label="Booking pages">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={view === t.id}
            onClick={() => setView(t.id)}
            className={
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition " +
              (view === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {view === "standard" ? (
        <Layout page="book-service">
          <OnlineBookingCard />
          <PublicLookCard />
        </Layout>
      ) : (
        <Layout page="book-service-site">
          <SiteBookingCard />
        </Layout>
      )}
    </div>
  );
}

/** The customer portal, with a live preview beside it. */
export function CustomerPortalTab() {
  return (
    <Layout page="customer">
      <CustomerPortalCard />
      <PublicLookCard />
    </Layout>
  );
}
