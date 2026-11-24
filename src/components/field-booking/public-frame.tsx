import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { bookingStyleOf } from "@/lib/field-services/booking-styles";

export type PublicTheme = "light" | "dark" | "auto";
export type PublicTone = "info" | "warn" | "ok" | "muted";

export const DEFAULT_PUBLIC_ACCENT = "#2563eb";

// Every token the page's components read is set here, so the visitor's own light or dark setting can't change them.
const LIGHT = `color-scheme:light;--background:oklch(1 0 0);--foreground:oklch(0.145 0 0);--card:oklch(1 0 0);--card-foreground:oklch(0.145 0 0);--popover:oklch(1 0 0);--popover-foreground:oklch(0.145 0 0);--muted:oklch(0.97 0 0);--muted-foreground:oklch(0.556 0 0);--accent:oklch(0.97 0 0);--accent-foreground:oklch(0.205 0 0);--secondary:oklch(0.97 0 0);--secondary-foreground:oklch(0.205 0 0);--destructive:oklch(0.577 0.245 27.325);--border:oklch(0.922 0 0);--input:oklch(0.922 0 0);--ls-warn:oklch(0.5 0.12 70);--ls-warn-bg:oklch(0.95 0.07 85);--ls-ok:oklch(0.45 0.12 150);--ls-ok-bg:oklch(0.95 0.06 150);`;
const DARK = `color-scheme:dark;--background:oklch(0.145 0 0);--foreground:oklch(0.985 0 0);--card:oklch(0.205 0 0);--card-foreground:oklch(0.985 0 0);--popover:oklch(0.205 0 0);--popover-foreground:oklch(0.985 0 0);--muted:oklch(0.269 0 0);--muted-foreground:oklch(0.708 0 0);--accent:oklch(0.269 0 0);--accent-foreground:oklch(0.985 0 0);--secondary:oklch(0.269 0 0);--secondary-foreground:oklch(0.985 0 0);--destructive:oklch(0.704 0.191 22.216);--border:oklch(1 0 0 / 10%);--input:oklch(1 0 0 / 15%);--ls-warn:oklch(0.82 0.14 85);--ls-warn-bg:oklch(0.3 0.06 85);--ls-ok:oklch(0.8 0.15 150);--ls-ok-bg:oklch(0.28 0.06 150);`;

// A short fade between steps, off for visitors who ask for less motion.
const MOTION = `.ls-step{animation:ls-in .2s ease-out both}@keyframes ls-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media (prefers-reduced-motion:reduce){.ls-step{animation:none}}`;

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mix(hex: string, target: [number, number, number], amount: number): string {
  const out = rgb(hex).map((v, i) => Math.round(v + (target[i] - v) * amount));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The brand colour as it must appear on this background: pale colours darkened for white, deep ones lightened for black. */
function accentFor(hex: string, mode: "light" | "dark"): string {
  if (mode === "light") return luminance(hex) > 0.5 ? mix(hex, [0, 0, 0], 0.45) : hex;
  return luminance(hex) < 0.2 ? mix(hex, [255, 255, 255], 0.5) : hex;
}

/** Text on a button of that colour. */
function onAccent(hex: string): string {
  return luminance(hex) > 0.4 ? "oklch(0.145 0 0)" : "oklch(0.985 0 0)";
}

function accentVars(hex: string, mode: "light" | "dark"): string {
  const a = accentFor(hex, mode);
  return `--ring:${a};--primary:${a};--primary-foreground:${onAccent(a)};`;
}

/** Only a plain hex colour ever reaches the style block. */
function safeAccent(v: string | null | undefined): string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_PUBLIC_ACCENT;
}

/** Surfaces, corners and type for a design direction. Empty for the standard look. */
function styleCss(styleId: string | null | undefined): { link: string | null; light: string; dark: string; shared: string; bgLight: string; bgDark: string } {
  const st = bookingStyleOf(styleId);
  const none = { link: null, light: "", dark: "", shared: "", bgLight: "oklch(1 0 0)", bgDark: "oklch(0.145 0 0)" };
  if (st.id === "default") return none;
  const vars = (v: NonNullable<typeof st.light>) =>
    `--background:${v.background};--foreground:${v.foreground};--card:${v.card};--card-foreground:${v.foreground};--popover:${v.card};--popover-foreground:${v.foreground};--muted:${v.muted};--muted-foreground:${v.mutedForeground};--accent:${v.muted};--accent-foreground:${v.foreground};--secondary:${v.muted};--secondary-foreground:${v.foreground};--border:${v.border};--input:${v.border};`;
  // The derived corner sizes are fixed at :root, so they are restated here from the new base.
  const r = st.radius;
  const radius = r
    ? `--radius:${r};--radius-sm:calc(var(--radius)*0.6);--radius-md:calc(var(--radius)*0.8);--radius-lg:var(--radius);--radius-xl:calc(var(--radius)*1.4);--radius-2xl:calc(var(--radius)*1.8);--radius-3xl:calc(var(--radius)*2.2);--radius-4xl:calc(var(--radius)*2.6);`
    : "";
  const type = `.ls-pub{font-family:${st.body}}.ls-pub :is(h1,h2,h3,.ls-display){font-family:${st.display};font-weight:${st.headingWeight};text-transform:${st.headingCase};letter-spacing:${st.headingTracking}}`;
  return {
    link: st.google ? `https://fonts.googleapis.com/css2?${st.google}&display=swap` : null,
    light: st.light ? vars(st.light) : "",
    dark: st.dark ? vars(st.dark) : "",
    shared: `.ls-pub{${radius}}${type}`,
    bgLight: st.light?.background ?? "oklch(1 0 0)",
    bgDark: st.dark?.background ?? "oklch(0.145 0 0)",
  };
}

/** The page chrome shared by the booking page, the customer portal and the tracking page. */
export function PublicFrame({
  theme,
  accent,
  style,
  wide,
  header,
  footer,
  children,
}: {
  theme: PublicTheme;
  accent: string | null | undefined;
  /** Design direction (`booking-styles.ts`); unknown or empty is the standard look. */
  style?: string | null;
  /** A wider column, for a page that shows more than one form. */
  wide?: boolean;
  /** A full-width bar across the top; its content lines up with the page column. */
  header?: ReactNode;
  /** A full-width band at the bottom of the page, below short content too. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const column = wide ? "max-w-4xl" : "max-w-lg";
  const a = safeAccent(accent);
  const sc = styleCss(style);
  const base = `.ls-pub{${accentVars(a, theme === "dark" ? "dark" : "light")}${theme === "dark" ? `${DARK}${sc.dark}` : `${LIGHT}${sc.light}`}}${sc.shared}`;
  const dark =
    theme === "auto"
      ? `@media (prefers-color-scheme: dark){.ls-pub{${accentVars(a, "dark")}${DARK}${sc.dark}}}`
      : "";
  // The page behind the card has to match, or the browser's own theme shows at the edges.
  const body =
    theme === "dark"
      ? `html,body{background:${sc.bgDark} !important}`
      : theme === "auto"
        ? `html,body{background:${sc.bgLight} !important}@media (prefers-color-scheme: dark){html,body{background:${sc.bgDark} !important}}`
        : `html,body{background:${sc.bgLight} !important}`;
  return (
    <>
      {sc.link && (
        <>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
          <link rel="stylesheet" href={sc.link} />
        </>
      )}
      <style>{`${base}${dark}${body}${MOTION}`}</style>
      <div className="ls-pub relative flex min-h-dvh flex-col bg-background text-foreground">
        {/* A soft wash of the brand colour, so the page feels branded without leaving the app's look. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-60 bg-gradient-to-b from-primary/10 to-transparent" />
        {header && (
          <div className="relative border-b bg-card/80 backdrop-blur">
            <div className={cn("mx-auto flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3", column)}>{header}</div>
          </div>
        )}
        <div className={cn("relative mx-auto w-full flex-1 px-4 pt-6 sm:pt-10", footer ? "pb-10" : "pb-16", column)}>{children}</div>
        {footer && (
          <div className="relative border-t bg-muted/40">
            <div className={cn("mx-auto w-full px-4 py-6", column)}>{footer}</div>
          </div>
        )}
      </div>
    </>
  );
}

/** The business logo, when it has one, beside its name. */
export function PublicBrand({ name, logoUrl, subtitle }: { name: string; logoUrl: string | null; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3">
      {logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- workspace-supplied URL, dimensions unknown
        <img src={logoUrl} alt="" referrerPolicy="no-referrer" className="h-11 max-w-[8rem] rounded object-contain" />
      )}
      <div className="min-w-0">
        <p className="ls-display truncate text-xl font-semibold tracking-tight">{name}</p>
        {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  );
}

export function PublicCard({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-2xl border bg-card p-5 shadow-sm sm:p-7", className)}>{children}</div>;
}

const TONES: Record<PublicTone, string> = {
  info: "bg-primary/10 text-primary",
  warn: "bg-[var(--ls-warn-bg)] text-[var(--ls-warn)]",
  ok: "bg-[var(--ls-ok-bg)] text-[var(--ls-ok)]",
  muted: "bg-muted text-muted-foreground",
};

/** A small coloured status label, the same on every public page. */
export function StatusPill({ tone, children }: { tone: PublicTone; children: ReactNode }) {
  return <span className={cn("inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium", TONES[tone])}>{children}</span>;
}

/** Where to reach the business, from the workspace's account contact. Shown only when there is something to show. */
export function ContactLine({
  name,
  contact,
  className = "mt-8",
}: {
  name: string;
  contact: { email: string | null; phone: string | null };
  className?: string;
}) {
  if (!contact.email && !contact.phone) return null;
  return (
    <p className={cn("text-center text-sm text-muted-foreground", className)}>
      Questions? Contact {name}
      {contact.phone && (
        <>
          {" · "}
          <a className="underline-offset-2 hover:underline" href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}>
            {contact.phone}
          </a>
        </>
      )}
      {contact.email && (
        <>
          {" · "}
          <a className="underline-offset-2 hover:underline" href={`mailto:${contact.email}`}>
            {contact.email}
          </a>
        </>
      )}
    </p>
  );
}

/** Phone and email as links, for a page header. Nothing when the business has neither. */
/** Whether the footer band has anything to show. */
export function hasPublicFooter(
  contact: { email: string | null; phone: string | null },
  footer: { name: string; address: string; phone: string; email: string; website: string } | null,
): boolean {
  if (!footer) return Boolean(contact.email || contact.phone);
  return Boolean(footer.name || footer.address || footer.phone || footer.email || footer.website);
}

/** The line at the bottom of the booking page: the business details the workspace chose to show. */
export function PublicFooter({
  name,
  contact,
  footer,
}: {
  name: string;
  contact: { email: string | null; phone: string | null };
  footer: { name: string; address: string; phone: string; email: string; website: string } | null;
}) {
  if (!footer) return <ContactLine name={name} contact={contact} className="" />;
  if (!footer.name && !footer.address && !footer.phone && !footer.email && !footer.website) return null;
  return (
    <footer className="text-center text-sm text-muted-foreground">
      <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        {footer.name && <span className="font-medium text-foreground">{footer.name}</span>}
        {footer.address && <span>{footer.address}</span>}
        {footer.phone && (
          <a className="underline-offset-2 hover:underline" href={`tel:${footer.phone.replace(/[^\d+]/g, "")}`}>
            {footer.phone}
          </a>
        )}
        {footer.email && (
          <a className="underline-offset-2 hover:underline" href={`mailto:${footer.email}`}>
            {footer.email}
          </a>
        )}
        {footer.website && (
          <a className="underline-offset-2 hover:underline" href={footer.website} target="_blank" rel="noopener noreferrer">
            {footer.website.replace(/^https?:\/\//i, "")}
          </a>
        )}
      </p>
    </footer>
  );
}

export function HeaderContact({ contact }: { contact: { email: string | null; phone: string | null } }) {
  if (!contact.email && !contact.phone) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      {contact.phone && (
        <a className="underline-offset-2 hover:underline" href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}>
          {contact.phone}
        </a>
      )}
      {contact.email && (
        <a className="underline-offset-2 hover:underline" href={`mailto:${contact.email}`}>
          {contact.email}
        </a>
      )}
    </p>
  );
}
