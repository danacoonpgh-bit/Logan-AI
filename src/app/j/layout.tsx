import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Your job",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const viewport: Viewport = { themeColor: "#18181b" };

export default function JobStatusLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-background text-foreground">{children}</div>;
}
