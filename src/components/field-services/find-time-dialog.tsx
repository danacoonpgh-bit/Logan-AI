"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { zonedDateKey } from "@/lib/field-services/time";
import { SELECT_CLASS } from "@/components/field-services/field-ui";
import { cn } from "@/lib/utils";

interface Found {
  startIso: string;
  endIso: string;
  day: string;
  label: string;
  time: string;
  workerIds: string[];
  workerName: string;
  driveMinutes: number | null;
  tag?: "best" | "earliest";
}

interface Result {
  timezone: string;
  days: string[];
  suggestions: Found[];
  byDay: Record<string, Found[]>;
  note: string | null;
}

const TAGS = { best: "Best match", earliest: "Earliest" } as const;

/** Suggests open times for a visit: the best fit by driving, the earliest, and every open time by day. */
export function FindTimeDialog({
  open,
  onClose,
  jobId,
  timezone,
  minutes,
  workerIds,
  ignoreVisitId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  jobId: string;
  timezone: string;
  minutes: number;
  /** People already chosen for the visit. Empty means anyone suitable. */
  workerIds: string[];
  ignoreVisitId?: string;
  onPick: (pick: { startIso: string; workerIds: string[] }) => void;
}) {
  const { subAccountId } = useSubAccount();
  const [from, setFrom] = useState(() => zonedDateKey(new Date(), timezone));
  const [part, setPart] = useState("any");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [day, setDay] = useState("");
  const idsKey = workerIds.join(",");
  const latest = useRef(0);

  const search = useCallback(async () => {
    const mine = ++latest.current;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/find-times`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, workerIds: idsKey ? idsKey.split(",") : [], minutes, from, days: 7, window: part, ignoreVisitId }),
      });
      const data = (await res.json().catch(() => ({}))) as Result & { error?: string };
      if (mine !== latest.current) return;
      if (!res.ok) {
        setResult(null);
        setError(data.error ?? "That didn't work.");
      } else {
        setResult(data);
        setDay((cur) => (cur && data.byDay[cur] ? cur : (data.days.find((d) => data.byDay[d]?.length) ?? "")));
      }
    } catch {
      if (mine === latest.current) setError("No connection. Try again.");
    } finally {
      if (mine === latest.current) setBusy(false);
    }
  }, [subAccountId, jobId, idsKey, minutes, from, part, ignoreVisitId]);

  useEffect(() => {
    if (open) void search();
  }, [open, search]);

  function choose(f: Found) {
    onPick({ startIso: f.startIso, workerIds: f.workerIds });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Find a time</DialogTitle>
          <DialogDescription>
            Open times for {minutes} minutes in {timezone}, for {workerIds.length > 0 ? "the people chosen" : "anyone set up for this work in this area"}.
            Working hours, time off, other visits, travel time and daily limits are all respected.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Week starting</Label>
            <Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Time of day</Label>
            <select className={SELECT_CLASS} value={part} onChange={(e) => setPart(e.target.value)}>
              <option value="any">Any time</option>
              <option value="morning">Morning</option>
              <option value="afternoon">Afternoon</option>
              <option value="evening">Evening</option>
            </select>
          </div>
        </div>

        {busy && !result && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Looking for times…
          </p>
        )}
        {error && <p className="text-sm text-amber-600 dark:text-amber-400">{error}</p>}

        {result && (
          <div className={cn("space-y-4", busy && "opacity-60")}>
            {result.note && <p className="text-sm text-muted-foreground">{result.note}</p>}

            {result.suggestions.length > 0 && (
              <section>
                <p className="mb-2 text-sm font-semibold">Suggested times</p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {result.suggestions.map((f) => (
                    <li key={`${f.startIso}-${f.workerIds.join("+")}`} className="rounded-lg border p-3">
                      {f.tag && <p className="mb-1 text-xs font-semibold text-primary">{TAGS[f.tag]}</p>}
                      <p className="text-sm font-medium">{f.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {f.workerName}
                        {f.driveMinutes !== null ? ` · about ${f.driveMinutes} min drive` : ""}
                      </p>
                      <Button className="mt-2" size="sm" variant="outline" onClick={() => choose(f)}>
                        Use this time
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <p className="mb-2 text-sm font-semibold">All open times</p>
              <div className="mb-2 flex flex-wrap gap-1">
                {result.days.map((d) => {
                  const n = result.byDay[d]?.length ?? 0;
                  return (
                    <button
                      key={d}
                      type="button"
                      disabled={n === 0}
                      aria-pressed={day === d}
                      onClick={() => setDay(d)}
                      className={cn(
                        "rounded-md border px-2 py-1 text-xs",
                        day === d ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                        n === 0 && "cursor-not-allowed opacity-40",
                      )}
                    >
                      {d.slice(5)} <span className="opacity-70">({n})</span>
                    </button>
                  );
                })}
              </div>
              {day && result.byDay[day] ? (
                <div className="flex flex-wrap gap-2">
                  {result.byDay[day].map((f) => (
                    <button
                      key={`${f.startIso}-${f.workerIds.join("+")}`}
                      type="button"
                      onClick={() => choose(f)}
                      className="rounded-md border px-2 py-1 text-left text-xs hover:bg-muted"
                    >
                      <span className="font-medium">{f.time}</span>
                      <span className="block text-muted-foreground">
                        {f.workerName}
                        {f.driveMinutes !== null ? ` · ${f.driveMinutes} min` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing open on that day.</p>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
