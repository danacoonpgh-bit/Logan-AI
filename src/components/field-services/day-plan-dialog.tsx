"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { callApi } from "@/components/field-services/field-ui";

interface Stop {
  visitId: string;
  title: string;
  address: string;
  startLabel: string;
  endLabel: string;
  wasWorkerName: string;
  wasLabel: string;
  changed: boolean;
  driveMinutes: number | null;
}

interface Plan {
  people: { workerId: string; name: string; areas: string[]; fixedCount: number; driveMinutes: number; stops: Stop[] }[];
  unplaced: { visitId: string; title: string; reason: string }[];
  changes: number;
}

/** Proposes who should do which flexible visit on a day, one part of town each, and applies it on request. */
export function DayPlanDialog({ open, day, onClose }: { open: boolean; day: string; onClose: () => void }) {
  const { subAccountId } = useSubAccount();
  const url = `/api/sub-accounts/${subAccountId}/field-services/route-suggestions`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);

  async function make() {
    setBusy(true);
    setError("");
    setPlan(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: true, day }),
      });
      const data = (await res.json().catch(() => ({}))) as Plan & { error?: string };
      if (!res.ok) setError(data.error ?? "That didn't work.");
      else setPlan(data);
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void make();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- plan again whenever the dialog opens for a day
  }, [open, day]);

  async function apply() {
    if (!plan) return;
    setBusy(true);
    const res = await callApi<{ moved: number }>(url, "POST", {
      plan: true,
      apply: true,
      day,
      assignments: plan.people.flatMap((p) => p.stops.map((s) => ({ visitId: s.visitId, workerId: p.workerId }))),
    });
    setBusy(false);
    if (!res) return;
    toast.success(`${res.moved} visit${res.moved === 1 ? "" : "s"} updated.`);
    onClose();
  }

  const quiet = plan?.people.reduce((n, p) => n + p.stops.length, 0) === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Plan the day</DialogTitle>
          <DialogDescription>
            {day}: each person gets one part of town, with the hours kept fair and the driving kept short. Visits you assigned by
            hand, visits a customer chose a time for and visits already under way stay where they are.
          </DialogDescription>
        </DialogHeader>

        {busy && !plan && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Working out the day…
          </p>
        )}
        {error && <p className="text-sm text-amber-600 dark:text-amber-400">{error}</p>}

        {plan && (
          <div className="space-y-4">
            {plan.people
              .filter((p) => p.stops.length > 0)
              .map((p) => (
                <section key={p.workerId} className="rounded-lg border">
                  <div className="border-b bg-muted/40 px-3 py-2">
                    <p className="text-sm font-semibold">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.areas.length > 0 ? p.areas.join(", ") : "Area not named"} · {p.stops.length} new{" "}
                      {p.stops.length === 1 ? "visit" : "visits"} · about {p.driveMinutes} min driving
                      {p.fixedCount > 0 ? ` · ${p.fixedCount} fixed visit${p.fixedCount === 1 ? "" : "s"} kept` : ""}
                    </p>
                  </div>
                  <ol className="divide-y text-sm">
                    {p.stops.map((s, i) => (
                      <li key={s.visitId} className="px-3 py-2">
                        <p className="font-medium">
                          {i + 1}. {s.title}
                          {!s.changed && <span className="ml-2 text-xs font-normal text-muted-foreground">No change</span>}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {s.startLabel} to {s.endLabel}
                          {s.changed ? ` · was ${s.wasWorkerName} at ${s.wasLabel}` : ""}
                          {s.driveMinutes !== null ? ` · ${s.driveMinutes} min drive` : ""}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{s.address}</p>
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            {quiet && <p className="text-sm text-muted-foreground">No visit could be placed.</p>}
            {plan.unplaced.length > 0 && (
              <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <p className="font-medium">Left as they are</p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {plan.unplaced.map((u) => (
                    <li key={u.visitId}>
                      {u.title}: {u.reason}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {plan.changes > 0 && (
              <p className="text-xs text-muted-foreground">
                Applying changes {plan.changes} visit{plan.changes === 1 ? "" : "s"}. The staff are alerted and each customer gets the
                service&apos;s moved message.
              </p>
            )}
            {plan.changes === 0 && !quiet && <p className="text-sm font-medium">The day is already planned this way.</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {plan && plan.changes > 0 && (
            <Button onClick={() => void apply()} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Apply the plan
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
