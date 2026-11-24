/** Looks for the booking page and customer portal that match the website builder's design directions. */

export type BookingStyleId = "default" | "dispatch" | "night_call" | "neighbourhood" | "quote_desk";

interface Surfaces {
  background: string;
  foreground: string;
  card: string;
  muted: string;
  mutedForeground: string;
  border: string;
}

export interface BookingStyle {
  id: BookingStyleId;
  label: string;
  blurb: string;
  /** The website builder design direction this matches. */
  concept: string | null;
  /** Google Fonts query for the two faces, or null to keep the app's own. */
  google: string | null;
  display: string;
  body: string;
  radius: string;
  headingWeight: number;
  headingCase: "none" | "uppercase";
  headingTracking: string;
  /** Colour and theme a pick starts from; both can be changed after. */
  accent: string;
  theme: "light" | "dark";
  light: Surfaces | null;
  dark: Surfaces | null;
}

const COOL_DARK: Surfaces = {
  background: "#0f172a",
  foreground: "#f1f5f9",
  card: "#172033",
  muted: "#1e293b",
  mutedForeground: "#94a3b8",
  border: "#334155",
};

export const BOOKING_STYLES: Record<BookingStyleId, BookingStyle> = {
  default: {
    id: "default",
    label: "Standard",
    blurb: "The app's own look: soft corners, system fonts.",
    concept: null,
    google: null,
    display: "inherit",
    body: "inherit",
    radius: "",
    headingWeight: 600,
    headingCase: "none",
    headingTracking: "normal",
    accent: "#2563eb",
    theme: "light",
    light: null,
    dark: null,
  },
  dispatch: {
    id: "dispatch",
    label: "Dispatch",
    blurb: "Industrial and square, condensed capitals, white with a strong blue.",
    concept: "home_dispatch",
    google: "family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@700;800",
    display: "'Barlow Condensed', 'Barlow', system-ui, sans-serif",
    body: "'Barlow', system-ui, sans-serif",
    radius: "0px",
    headingWeight: 800,
    headingCase: "uppercase",
    headingTracking: "0.01em",
    accent: "#003da6",
    theme: "light",
    light: { background: "#ffffff", foreground: "#111827", card: "#ffffff", muted: "#f3f4f6", mutedForeground: "#4b5563", border: "#d1d5db" },
    dark: COOL_DARK,
  },
  night_call: {
    id: "night_call",
    label: "Night call",
    blurb: "Dark slate with hazard-yellow accents and condensed capitals.",
    concept: "home_nightcall",
    google: "family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@700;800",
    display: "'Barlow Condensed', 'Barlow', system-ui, sans-serif",
    body: "'Barlow', system-ui, sans-serif",
    radius: "0.25rem",
    headingWeight: 800,
    headingCase: "uppercase",
    headingTracking: "0.01em",
    accent: "#ffcd00",
    theme: "dark",
    light: { background: "#f8fafc", foreground: "#0f172a", card: "#ffffff", muted: "#eef2f7", mutedForeground: "#475569", border: "#cbd5e1" },
    dark: COOL_DARK,
  },
  neighbourhood: {
    id: "neighbourhood",
    label: "Neighbourhood",
    blurb: "Warm paper, a teal accent and a friendly serif.",
    concept: "home_neighbourhood",
    google: "family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Manrope:wght@400;500;600;700",
    display: "'Fraunces', Georgia, serif",
    body: "'Manrope', system-ui, sans-serif",
    radius: "1rem",
    headingWeight: 600,
    headingCase: "none",
    headingTracking: "-0.01em",
    accent: "#0b7a75",
    theme: "light",
    light: { background: "#fbf7f0", foreground: "#1e1b16", card: "#fffdf8", muted: "#f3ede3", mutedForeground: "#5d564b", border: "#e3dacb" },
    dark: { background: "#141210", foreground: "#f3ede3", card: "#1d1a17", muted: "#272320", mutedForeground: "#b3a99a", border: "#3a342d" },
  },
  quote_desk: {
    id: "quote_desk",
    label: "Quote desk",
    blurb: "Bright and corporate, square corners, orange on white.",
    concept: "home_quotedesk",
    google: "family=Source+Sans+3:wght@600;700;800&family=Poppins:wght@400;500;600",
    display: "'Source Sans 3', system-ui, sans-serif",
    body: "'Poppins', system-ui, sans-serif",
    radius: "0px",
    headingWeight: 700,
    headingCase: "none",
    headingTracking: "-0.01em",
    accent: "#f28124",
    theme: "light",
    light: { background: "#ffffff", foreground: "#252525", card: "#ffffff", muted: "#f7f7f7", mutedForeground: "#5a5a5a", border: "#e2e2e2" },
    dark: { background: "#14181f", foreground: "#f4f4f5", card: "#1b2029", muted: "#232a35", mutedForeground: "#a1a8b3", border: "#2e3643" },
  },
};

export const BOOKING_STYLE_IDS = Object.keys(BOOKING_STYLES) as BookingStyleId[];

/** Anything unknown or missing reads as the standard look. */
export function bookingStyleOf(id: unknown): BookingStyle {
  return isBookingStyleId(id) ? BOOKING_STYLES[id] : BOOKING_STYLES.default;
}

export function isBookingStyleId(id: unknown): id is BookingStyleId {
  return typeof id === "string" && Object.hasOwn(BOOKING_STYLES, id);
}

/** The booking style that matches a website builder design direction. */
export function styleForConcept(concept: string | null | undefined): BookingStyleId {
  const hit = BOOKING_STYLE_IDS.find((k) => concept && BOOKING_STYLES[k].concept === concept);
  return hit ?? "default";
}
