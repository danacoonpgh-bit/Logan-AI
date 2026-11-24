"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Person {
  id: string;
  name: string;
  status?: string;
}

/** Chosen people show as pills (click one to remove it); everyone else is in a short, searchable list below. */
export function StaffPicker({
  people,
  value,
  onChange,
  disabled,
  noun = "staff",
  empty,
}: {
  people: Person[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  noun?: string;
  empty?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const chosen = value.map((id) => byId.get(id)).filter((p): p is Person => !!p);
  const left = people
    .filter((p) => p.status !== "removed" && !value.includes(p.id))
    .filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const anyLeft = people.some((p) => p.status !== "removed" && !value.includes(p.id));

  if (people.length === 0) {
    return <p className="text-xs text-muted-foreground">{empty ?? `Add ${noun} first.`}</p>;
  }

  return (
    <div className="space-y-2">
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(value.filter((id) => id !== p.id))}
              aria-label={`Remove ${p.name}`}
              className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-destructive/20 disabled:opacity-60"
            >
              {p.name}
              {p.status === "removed" ? " (removed)" : ""}
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}

      {anyLeft && (
        <div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline disabled:opacity-60"
          >
            <Plus className="h-3 w-3" />
            {open ? "Hide list" : chosen.length > 0 ? `Add another` : `Choose ${noun}`}
          </button>
          {open && (
            <div className="mt-1.5 rounded-md border bg-card p-1.5">
              {people.length > 6 && (
                <Input
                  className="mb-1.5 h-8"
                  placeholder="Search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              )}
              <div className={cn("flex max-h-40 flex-col overflow-y-auto")}>
                {left.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No match.</p>}
                {left.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onChange([...value, p.id]);
                      setQuery("");
                    }}
                    className="rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-60"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
