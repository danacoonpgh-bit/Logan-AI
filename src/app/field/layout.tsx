import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Field",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
  appleWebApp: { capable: true, title: "Field", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#18181b" },
  ],
  viewportFit: "cover",
};

export default function FieldLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-background text-foreground [padding-bottom:env(safe-area-inset-bottom)] [padding-top:env(safe-area-inset-top)]">
      {children}
    </div>
  );
}
