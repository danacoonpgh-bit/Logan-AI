"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StaffPicker } from "@/components/field-services/staff-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callApi } from "@/components/field-services/field-ui";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { jobTerms, workerTerms } from "@/lib/field-services/terms";
import type { FieldWorker, InternalJob } from "@/types/field-services";

interface Draft {
  id: string | null;
  name: string;
  allCrew: boolean;
  workerIds: string[];
  timers: boolean;
}

const EMPTY: Draft = { id: null, name: "", allCrew: true, workerIds: [], timers: false };

export function InternalJobsSection({ workers, newSignal = 0 }: { workers: FieldWorker[]; newSignal?: number }) {
  const { subAccountId } = useSubAccount();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const wt = workerTerms(config);
  const base = `/api/sub-accounts/${subAccountId}/field-services/internal-jobs`;
  const [jobs, setJobs] = useState<InternalJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const active = workers.filter((w) => w.status === "active");

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: "no-store" });
      if (res.ok) setJobs(((await res.json()) as { jobs: InternalJob[] }).jobs);
    } finally {
      setLoaded(true);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  // The New project form hands over here when Internal is picked.
  useEffect(() => {
    if (newSignal > 0) setDraft({ ...EMPTY });
  }, [newSignal]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    const body = {
      name: draft.name,
      allCrew: draft.allCrew,
      workerIds: draft.allCrew ? [] : draft.workerIds,
      timersEnabled: draft.timers,
    };
    const res = draft.id ? await callApi(`${base}/${draft.id}`, "PATCH", body) : await callApi(base, "POST", body);
    setBusy(false);
    if (!res) return;
    toast.success(draft.id ? `Internal ${terms.job} saved.` : `Internal ${terms.job} added.`);
    setDraft(null);
    await load();
  }

  async function setArchived(job: InternalJob, archived: boolean) {
    if (await callApi(`${base}/${job.id}`, "PATCH", { archived })) await load();
  }

  function who(job: InternalJob): string {
    if (job.allCrew) return `All ${wt.workers}`;
    const names = job.workerIds.map((id) => workers.find((w) => w.id === id)?.name).filter(Boolean);
    return names.length ? names.join(", ") : "No one yet";
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Internal {terms.jobs}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Work with no customer, like a bid, the workshop or admin. {wt.Workers} can book time to them, but they are never scheduled,
            messaged or invoiced: all time and expenses are cost only.
          </p>
        </div>
        <Button size="sm" onClick={() => setDraft({ ...EMPTY })}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add internal {terms.job}
        </Button>
      </div>

      {!loaded ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : jobs.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="mt-4 divide-y rounded-lg border">
          {jobs.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className={"truncate text-sm font-medium " + (j.archived ? "text-muted-foreground line-through" : "")}>
                  {j.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {who(j)}
                  {j.archived ? " · archived" : ""}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDraft({ id: j.id, name: j.name, allCrew: j.allCrew, workerIds: j.workerIds, timers: j.timersEnabled === true })}
              >
                Edit
              </Button>
              <Button variant="outline" size="sm" onClick={() => void setArchived(j, !j.archived)}>
                {j.archived ? "Restore" : "Archive"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.id ? `Edit internal ${terms.job}` : `New internal ${terms.job}`}</DialogTitle>
            <DialogDescription>Choose who can book time to it.</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-4">
              <div>
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Name</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Workshop"
                  disabled={busy}
                />
              </div>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={draft.timers}
                  onCheckedChange={(v) => setDraft({ ...draft, timers: v === true })}
                />
                <span>
                  <span className="block font-medium">Allow a start and stop timer</span>
                  <span className="block text-xs text-muted-foreground">Off by default. Without it, {wt.workers} just enter their hours.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.allCrew}
                  onCheckedChange={(v) => setDraft({ ...draft, allCrew: v === true })}
                />
                All {wt.workers}
              </label>
              {!draft.allCrew && (
                <StaffPicker
                  people={active}
                  value={draft.workerIds}
                  onChange={(ids) => setDraft({ ...draft, workerIds: ids })}
                  noun={wt.workers}
                />
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || !draft?.name.trim()}>
              {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
