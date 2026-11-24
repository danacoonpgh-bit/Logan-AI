"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useFieldData } from "@/components/field-services/field-data";
import { SELECT_CLASS, callApi } from "@/components/field-services/field-ui";

interface Suggestion {
  workerName: string;
  currentDriveMinutes: number;
  suggestedDriveMinutes: number;
  better: boolean;
  message: string;
  returnMinutes?: number | null;
  stops: { visitId: string; title: string; address: string; startLabel: string; endLabel: string; wasLabel: string; driveMinutes: number }[];
}

/** Suggests the shortest driving order for one person's day and, on request, re-times the visits to match. */
export function RouteSuggestDialog({ open, day, onClose }: { open: boolean; day: string; onClose: () => void }) {
  const { subAccountId } = useSubAccount();
  const { workers } = useFieldData();
  const people = workers.filter((w) => w.status === "active");
  const [workerId, setWorkerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Suggestion | null>(null);
  const url = `/api/sub-accounts/${subAccountId}/field-services/route-suggestions`;

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError("");
  }, [open, day]);

  async function suggest() {
    if (!workerId) return;
    setBusy(true);
    setError("");
    setResult(null);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId, day }),
    });
    const data = (await res.json().catch(() => ({}))) as Suggestion & { error?: string };
    setBusy(false);
    if (!res.ok) setError(data.error ?? "That didn't work.");
    else setResult(data);
  }

  async function apply() {
    if (!result) return;
    setBusy(true);
    const res = await callApi<{ moved: number; warnings: string[] }>(url, "POST", {
      workerId,
      day,
      apply: true,
      order: result.stops.map((s) => s.visitId),
    });
    setBusy(false);
    if (!res) return;
    toast.success(`${res.moved} visit${res.moved === 1 ? "" : "s"} re-timed.`);
    for (const w of res.warnings) toast.warning(w);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Suggest route</DialogTitle>
          <DialogDescription>
            The order with the least driving for one person on {day}. The day keeps its time slots, and visits move between them only as far as the driving needs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Staff member</Label>
            <select
              className={SELECT_CLASS}
              value={workerId}
              disabled={busy}
              onChange={(e) => {
                setWorkerId(e.target.value);
                setResult(null);
                setError("");
              }}
            >
              <option value="">Choose…</option>
              {people.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-amber-600 dark:text-amber-400">{error}</p>}
          {result && (
            <div className="space-y-2">
              <p className="text-sm">
                <span className="font-medium">{result.message}</span> Driving now {result.currentDriveMinutes} min, suggested{" "}
                {result.suggestedDriveMinutes} min.
              </p>
              <ol className="divide-y rounded-lg border text-sm">
                {result.stops.map((s, i) => (
                  <li key={s.visitId} className="p-2.5">
                    <p className="font-medium">
                      {i + 1}. {s.title}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.startLabel} to {s.endLabel}
                      {s.wasLabel !== s.startLabel ? ` (was ${s.wasLabel})` : ""} · {i === 0 ? "from their start address" : "drive"}{" "}
                      {s.driveMinutes} min
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{s.address}</p>
                  </li>
                ))}
              </ol>
              {typeof result.returnMinutes === "number" && (
                <p className="text-xs text-muted-foreground">Then {result.returnMinutes} min back to their start address.</p>
              )}
              {result.better && (
                <p className="text-xs text-muted-foreground">
                  Applying moves the visit times. The staff are alerted and each customer gets the service&apos;s moved message.
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button variant={result ? "outline" : "default"} onClick={() => void suggest()} disabled={busy || !workerId}>
            {busy && !result && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {result ? "Suggest again" : "Suggest route"}
          </Button>
          {result?.better && (
            <Button onClick={() => void apply()} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Apply and re-time
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
