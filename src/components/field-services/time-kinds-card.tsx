"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { DEFAULT_TIME_KINDS } from "@/lib/field-services/time-kinds";
import { activityTerm } from "@/lib/field-services/terms";
import type { TimeKindDef } from "@/types/field-services";

/** The kinds of time crew pick on a project, such as Driving or Admin. A disabled kind keeps its name on older entries. */
export function TimeKindsCard() {
  const { subAccountId } = useSubAccount();
  const { config, reload } = useFieldConfig();
  const [kinds, setKinds] = useState<TimeKindDef[]>(DEFAULT_TIME_KINDS);
  const [busy, setBusy] = useState(false);
  const filled = useRef(false);

  useEffect(() => {
    if (!config || filled.current) return;
    filled.current = true;
    setKinds(config.timeKinds ?? DEFAULT_TIME_KINDS);
  }, [config]);

  if (!config) return null;
  const activity = activityTerm(config);
  const enabledCount = kinds.filter((k) => !k.archived).length;
  const dirty = JSON.stringify(kinds) !== JSON.stringify(config.timeKinds ?? DEFAULT_TIME_KINDS);

  function change(id: string, patch: Partial<TimeKindDef>) {
    setKinds((cur) => cur.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeKinds: kinds }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "That didn't save.");
        return;
      }
      toast.success("Saved.");
      filled.current = false;
      reload();
    } catch {
      toast.error("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <h2 className="text-base font-semibold">{activity}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        What crew pick when they log time on a project, for example Driving, Admin or Quoting. Time on a visit and breaks have their own
        names. A disabled one is not offered to crew, but keeps its name on older entries.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Billable</span> only matters on Time &amp; materials projects: billable
        time is charged to the customer. On a Fixed price project no time is ever invoiced, so every hour booked is for cost reporting only.
      </p>
      <ul className="mt-4 divide-y rounded-lg border">
        {kinds.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center gap-3 p-3">
            <Input
              aria-label="Name"
              className="h-9 max-w-xs flex-1"
              maxLength={40}
              value={k.label}
              onChange={(e) => change(k.id, { label: e.target.value })}
            />
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={k.projectDefault === true}
                disabled={!!k.archived}
                onCheckedChange={(v) => change(k.id, { projectDefault: v === true ? true : undefined })}
              />
              New projects start with it
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={!k.archived}
                disabled={!k.archived && enabledCount <= 1}
                onCheckedChange={(v) => change(k.id, { archived: v === true ? undefined : true })}
              />
              Enabled
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={k.billable} onCheckedChange={(v) => change(k.id, { billable: v === true })} />
              Billable
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setKinds((cur) => [...cur, { id: `new_${cur.length}_${Date.now().toString(36)}`, label: "", billable: false }])}
        >
          Add {activity.toLowerCase()}
        </Button>
        <Button type="button" size="sm" disabled={busy || !dirty || kinds.some((k) => !k.label.trim())} onClick={() => void save()}>
          {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
      </div>
    </section>
  );
}
