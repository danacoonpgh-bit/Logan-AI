import { cookies } from "next/headers";
import { brandCookieName, parseBrand } from "@/lib/field-portal/brand-cookie";

/** Shown the instant the crew app opens, while the page behind it is still being prepared. */
export async function BrandSplash({ subAccountId }: { subAccountId: string }) {
  const jar = await cookies();
  const brand = parseBrand(jar.get(brandCookieName(subAccountId))?.value);
  return (
    <div role="status" aria-live="polite" className="flex min-h-dvh flex-col items-center justify-center gap-5 p-6 text-center">
      {brand?.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a remote logo of any size, shown while loading
        <img src={brand.logoUrl} alt="" referrerPolicy="no-referrer" className="h-16 max-w-[12rem] rounded object-contain" />
      ) : brand ? (
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-2xl font-semibold text-primary-foreground" aria-hidden="true">
          {brand.name.trim().charAt(0).toUpperCase()}
        </span>
      ) : null}
      {brand && <p className="text-lg font-semibold">{brand.name}</p>}
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
