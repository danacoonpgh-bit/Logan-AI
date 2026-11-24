"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { callApi } from "@/components/field-services/field-ui";

interface Balance {
  moves: { visitId: string; title: string; address: string; timeLabel: string; fromName: string; toName: string; toWorkerId: string }[];
  people: { workerId: string; name: string; visitsBefore: number; visitsAfter: number; driveMinutesBefore: number; driveMinutesAfter: number }[];
  driveMinutesBefore: number;
  driveMinutesAfter: number;
}

/** Proposes handing some of a day's visits to a different person, keeping every time as it is, to cut the driving. */
export function BalanceStaffDialog({ open, day, onClose }: { open: boolean; day: string; onClose: () => void }) {
  const { subAccountId } = useSubAccount();
  const url = `/api/sub-accounts/${subAccountId}/field-services/route-suggestions`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<Balance | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setBusy(true);
    setError("");
    setPlan(null);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ balance: true, day }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as Balance & { error?: string };
        if (!live) return;
        if (!res.ok) setError(data.error ?? "That didn't work.");
        else setPlan(data);
      })
      .catch(() => live && setError("No connection. Try again."))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [open, day, url]);

  async function apply() {
    if (!plan) return;
    setBusy(true);
    const res = await callApi<{ moved: number }>(url, "POST", {
      balance: true,
      apply: true,
      day,
      assignments: plan.moves.map((m) => ({ visitId: m.visitId, workerId: m.toWorkerId })),
    });
    setBusy(false);
    if (!res) return;
    toast.success(`${res.moved} visit${res.moved === 1 ? "" : "s"} handed to a different person.`);
    onClose();
  }

  const saved = plan ? plan.driveMinutesBefore - plan.driveMinutesAfter : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Balance staff</DialogTitle>
          <DialogDescription>
            {day}: every visit keeps its time. Some may go to a different person so each person&apos;s day is made of nearby
            visits. Only visits the system placed itself can change person; visits assigned by hand, or with a fixed arrival, stay put.
          </DialogDescription>
        </DialogHeader>

        {busy && !plan && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Looking at the day…
          </p>
        )}
        {error && <p className="text-sm text-amber-600 dark:text-amber-400">{error}</p>}

        {plan && plan.moves.length === 0 && (
          <p className="text-sm font-medium">The day is already well balanced. No one needs to swap.</p>
        )}

        {plan && plan.moves.length > 0 && (
          <div className="space-y-4">
            <ul className="divide-y rounded-lg border text-sm">
              {plan.moves.map((m) => (
                <li key={m.visitId} className="px-3 py-2">
                  <p className="font-medium">{m.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {m.timeLabel} · {m.fromName} <span aria-hidden>→</span> <span className="font-medium text-foreground">{m.toName}</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{m.address}</p>
                </li>
              ))}
            </ul>
            <div className="rounded-lg border">
              <p className="border-b bg-muted/40 px-3 py-2 text-xs font-medium">
                Driving for the day: about {plan.driveMinutesBefore} min now, {plan.driveMinutesAfter} min after
                {saved > 0 ? ` (${saved} min less)` : ""}
              </p>
              <ul className="divide-y text-xs text-muted-foreground">
                {plan.people.map((p) => (
                  <li key={p.workerId} className="flex flex-wrap justify-between gap-2 px-3 py-1.5">
                    <span className="font-medium text-foreground">{p.name}</span>
                    <span>
                      {p.visitsBefore} → {p.visitsAfter} visits · {p.driveMinutesBefore} → {p.driveMinutesAfter} min driving
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">
              Times do not change, so customers are not messaged. The staff who gain or lose a visit are alerted.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {plan && plan.moves.length > 0 && (
            <Button onClick={() => void apply()} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Apply the changes
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
