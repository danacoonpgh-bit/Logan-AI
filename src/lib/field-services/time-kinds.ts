import type { TimeKindDef } from "@/types/field-services";

/** The kinds of time a workspace starts with. Their ids are what older time entries already carry. */
export const DEFAULT_TIME_KINDS: TimeKindDef[] = [
  { id: "onsite", label: "On site", billable: true, projectDefault: true },
  { id: "travel", label: "Driving", billable: true, projectDefault: true },
  { id: "admin", label: "Admin", billable: false, projectDefault: true },
  { id: "general", label: "General", billable: false, projectDefault: true },
];

const FIXED_LABELS: Record<string, string> = { visit: "Visit", break: "Break" };
const RESERVED = new Set(["visit", "break"]);
const ID = /^[a-z0-9_]{1,24}$/;

export function kindLabelOf(kinds: TimeKindDef[] | undefined, id: string): string {
  return FIXED_LABELS[id] ?? (kinds ?? DEFAULT_TIME_KINDS).find((k) => k.id === id)?.label ?? id;
}

/** The kinds a worker can pick today. */
export function activeTimeKinds(kinds: TimeKindDef[] | undefined): TimeKindDef[] {
  return (kinds ?? DEFAULT_TIME_KINDS).filter((k) => !k.archived);
}

/**
 * Checks an admin's list. A kind left out is kept archived so older entries keep a name; one must stay in use.
 */
export function cleanTimeKinds(raw: unknown, saved: TimeKindDef[] | undefined): TimeKindDef[] | string {
  if (!Array.isArray(raw) || raw.length > 30) return "The kinds of time aren't valid.";
  const out: TimeKindDef[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const k = (r ?? {}) as Partial<TimeKindDef>;
    const label = typeof k.label === "string" ? k.label.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (!label) return "Give every kind of time a name.";
    let id = typeof k.id === "string" && ID.test(k.id) && !RESERVED.has(k.id) ? k.id : "";
    if (!id) id = `k_${Math.random().toString(36).slice(2, 8)}`;
    if (seen.has(id)) return "Two kinds of time have the same id.";
    seen.add(id);
    out.push({
      id,
      label,
      billable: k.billable === true,
      ...(k.projectDefault === true ? { projectDefault: true } : {}),
      ...(k.archived === true ? { archived: true } : {}),
    });
  }
  for (const old of saved ?? DEFAULT_TIME_KINDS) {
    if (!seen.has(old.id)) out.push({ ...old, archived: true });
  }
  if (!out.some((k) => !k.archived)) return "Keep at least one kind of time in use.";
  return out;
}

/** The activities a new project starts with: the ones ticked as a default, or every enabled one when none is. */
export function defaultActivityIds(kinds: TimeKindDef[] | undefined): string[] {
  const active = activeTimeKinds(kinds);
  const flagged = active.filter((k) => k.projectDefault === true);
  return (flagged.length > 0 ? flagged : active).map((k) => k.id);
}

/** The activities staff can book on one project. A project that never chose gets every enabled activity. */
export function projectActivities(kinds: TimeKindDef[] | undefined, job: { activityIds?: string[] | null }): TimeKindDef[] {
  const active = activeTimeKinds(kinds);
  const own = job.activityIds ? active.filter((k) => job.activityIds!.includes(k.id)) : active;
  return own.length > 0 ? own : active;
}
