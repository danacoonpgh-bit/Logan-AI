import { HeaderContact, PublicBrand, PublicFooter, PublicFrame, hasPublicFooter } from "@/components/field-booking/public-frame";
import { FieldBookingForm } from "@/components/field-booking/booking-form";
import type { PublicBookingConfig } from "@/lib/server/field-booking-service";

/** One booking page for the standard address and the website one; only the config differs. */
export function BookingPageView({ subAccountId, config }: { subAccountId: string; config: PublicBookingConfig | null }) {
  return (
    <PublicFrame
      wide
      theme={config?.theme ?? "light"}
      accent={config?.accent}
      style={config?.style}
      header={
        config && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <PublicBrand name={config.businessName} logoUrl={config.logoUrl} />
              {config.backLink && (
                <a className="text-sm text-muted-foreground underline-offset-2 hover:underline" href={config.backLink.url}>
                  ← {config.backLink.label}
                </a>
              )}
            </div>
            <HeaderContact contact={config.contact} />
          </>
        )
      }
      footer={
        config && hasPublicFooter(config.contact, config.footer) ? (
          <PublicFooter name={config.businessName} contact={config.contact} footer={config.footer} />
        ) : undefined
      }
    >
      {config ? (
        <FieldBookingForm subAccountId={subAccountId} config={config} />
      ) : (
        <div className="mt-16 rounded-2xl border bg-card p-8 text-center">
          <h1 className="text-xl font-semibold">Online booking isn&apos;t available</h1>
          <p className="mt-2 text-sm text-muted-foreground">Please contact the business directly.</p>
        </div>
      )}
    </PublicFrame>
  );
}
