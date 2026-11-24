"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { Checkbox } from "@/components/ui/checkbox";
import { callApi } from "@/components/field-services/field-ui";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";

interface State {
  enabled: boolean;
  leadDays: number;
  maxDays: number;
  awareSlots: boolean;
  returnToBase: boolean;
  readiness: { ok: boolean; checks: { id: string; label: string; ok: boolean; fix: string }[] };
}

/** Switch for route suggestions, with the checks that must pass before it can be turned on. */
export function RouteSuggestionsCard() {
  const { subAccountId } = useSubAccount();
  const { reload } = useFieldConfig();
  const url = `/api/sub-accounts/${subAccountId}/field-services/route-suggestions`;
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) setState((await res.json()) as State);
    } catch {
      // The card stays on its checking state until the next try.
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(on: boolean) {
    setBusy(true);
    const res = await callApi(`/api/sub-accounts/${subAccountId}/field-services/config`, "PATCH", { routeSuggestionsEnabled: on });
    setBusy(false);
    if (!res) return;
    toast.success(on ? "Route suggestions are on." : "Route suggestions are off.");
    reload();
    await load();
  }

  async function toggleAware(on: boolean) {
    setBusy(true);
    const res = await callApi(`/api/sub-accounts/${subAccountId}/field-services/config`, "PATCH", { routeAwareSlots: on });
    setBusy(false);
    if (!res) return;
    toast.success(on ? "Online booking now offers the best-fitting times." : "Online booking offers every free time.");
    reload();
    await load();
  }

  async function toggleReturn(on: boolean) {
    setBusy(true);
    const res = await callApi(`/api/sub-accounts/${subAccountId}/field-services/config`, "PATCH", { routeReturnToBase: on });
    setBusy(false);
    if (!res) return;
    toast.success(on ? "Routes now count the drive back to base." : "Routes end at the last visit.");
    reload();
    await load();
  }

  async function setMax(n: number) {
    setBusy(true);
    const res = await callApi(`/api/sub-accounts/${subAccountId}/field-services/config`, "PATCH", { routeMaxDays: n });
    setBusy(false);
    if (!res) return;
    toast.success("Saved.");
    reload();
    await load();
  }

  async function setLead(n: number) {
    setBusy(true);
    const res = await callApi(`/api/sub-accounts/${subAccountId}/field-services/config`, "PATCH", { routeLeadDays: n });
    setBusy(false);
    if (!res) return;
    toast.success("Lead time saved.");
    reload();
    await load();
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <h2 className="text-base font-semibold">Route suggestions</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        For a day with two or more visits, the Schedule tab can suggest the order that cuts the most driving and re-time the visits
        to match. Applying it moves visit times, so the staff and customers get the usual moved messages. It is meant for a business
        that offers a few uniform services.
      </p>
      {!state ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
        </p>
      ) : (
        <>
          <ul className="mt-3 space-y-1.5">
            {state.readiness.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-sm">
                {c.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span>
                  {c.label}
                  {!c.ok && <span className="block text-xs text-muted-foreground">{c.fix}</span>}
                </span>
              </li>
            ))}
          </ul>
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={state.enabled}
              disabled={busy || (!state.enabled && !state.readiness.ok)}
              onCheckedChange={(v) => void toggle(v === true)}
            />
            Turn on route suggestions
          </label>
          {!state.enabled && !state.readiness.ok && (
            <p className="mt-1 text-xs text-muted-foreground">Finish the checks above to turn this on.</p>
          )}
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Checkbox checked={state.awareSlots} disabled={busy || !state.enabled} onCheckedChange={(v) => void toggleAware(v === true)} />
            Offer the best-fitting times online
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Instant booking hides times that would send someone across town, or that they could not reach in time from their
            previous visit, and gives the visit to whoever it fits best. If nothing nearby is free, the least out-of-the-way
            times still show, so a customer is never left with none. Needs route suggestions on.
          </p>
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Checkbox checked={state.returnToBase} disabled={busy || !state.enabled} onCheckedChange={(v) => void toggleReturn(v === true)} />
            Staff return to their start address at the end of the day
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            For a vehicle that has to go back to the office or depot. Suggest route, Plan the day and Balance staff then count the drive
            home, and the last visit of the day must leave time for it before working hours end. Set the start address to where the
            vehicle lives. Needs route suggestions on.
          </p>
          <div className="mt-4">
            <label className="text-sm font-medium" htmlFor="route-lead-days">
              Lead time
            </label>
            <select
              id="route-lead-days"
              className="mt-1 block h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm [&_option]:bg-background [&_option]:text-foreground"
              value={state.leadDays}
              disabled={busy}
              onChange={(e) => void setLead(Number(e.target.value))}
            >
              {Array.from({ length: 14 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "day" : "days"}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Today and the days inside this lead time are never planned or reordered by the system, so they are changed by hand.
              With {state.leadDays} {state.leadDays === 1 ? "day" : "days"}, route suggestions start from{" "}
              {state.leadDays === 1 ? "tomorrow" : `${state.leadDays} days from today`}.
            </p>
          </div>
          <div className="mt-4">
            <label className="text-sm font-medium" htmlFor="route-max-days">
              How far ahead
            </label>
            <select
              id="route-max-days"
              className="mt-1 block h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm [&_option]:bg-background [&_option]:text-foreground"
              value={state.maxDays}
              disabled={busy}
              onChange={(e) => void setMax(Number(e.target.value))}
            >
              {[7, 14, 21, 28].map((n) => (
                <option key={n} value={n}>
                  {n} days
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Suggest route, Plan the day and Balance staff work on days up to this far from today. Days further out stay as they
              are until they come closer.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
