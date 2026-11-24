/**
 * Colours for the timesheet Submit and Unlock buttons, each with light and dark classes.
 */
export const BUTTON_COLOR_IDS = ["default", "blue", "green", "teal", "violet", "amber", "red", "slate"] as const;
export type ButtonColorId = (typeof BUTTON_COLOR_IDS)[number];

export const BUTTON_COLORS: Record<ButtonColorId, { label: string; classes: string; swatch: string }> = {
  default: { label: "Theme", classes: "", swatch: "bg-foreground" },
  blue: {
    label: "Blue",
    classes:
      "border-transparent bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:text-blue-950 dark:hover:bg-blue-400",
    swatch: "bg-blue-600 dark:bg-blue-500",
  },
  green: {
    label: "Green",
    classes:
      "border-transparent bg-green-600 text-white hover:bg-green-700 dark:bg-green-500 dark:text-green-950 dark:hover:bg-green-400",
    swatch: "bg-green-600 dark:bg-green-500",
  },
  teal: {
    label: "Teal",
    classes:
      "border-transparent bg-teal-600 text-white hover:bg-teal-700 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300",
    swatch: "bg-teal-600 dark:bg-teal-400",
  },
  violet: {
    label: "Violet",
    classes:
      "border-transparent bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-400 dark:text-violet-950 dark:hover:bg-violet-300",
    swatch: "bg-violet-600 dark:bg-violet-400",
  },
  amber: {
    label: "Amber",
    classes:
      "border-transparent bg-amber-500 text-amber-950 hover:bg-amber-600 dark:bg-amber-400 dark:hover:bg-amber-300",
    swatch: "bg-amber-500 dark:bg-amber-400",
  },
  red: {
    label: "Red",
    classes:
      "border-transparent bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:text-red-950 dark:hover:bg-red-400",
    swatch: "bg-red-600 dark:bg-red-500",
  },
  slate: {
    label: "Slate",
    classes:
      "border-transparent bg-slate-700 text-white hover:bg-slate-800 dark:bg-slate-300 dark:text-slate-900 dark:hover:bg-slate-200",
    swatch: "bg-slate-700 dark:bg-slate-300",
  },
};

export function buttonColorClasses(id: unknown): string {
  return typeof id === "string" && id in BUTTON_COLORS ? BUTTON_COLORS[id as ButtonColorId].classes : "";
}
