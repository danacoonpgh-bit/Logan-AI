"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Loader2, RefreshCw, X } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";

export interface SetupItem {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  fix: string;
  tab: "workers" | "setup" | "settings" | "booking" | "";
  action: string;
}

export type SetupTarget = "workers" | "setup" | "settings" | "booking";

/** Loads the setup checklist. Reload after the user changes something elsewhere. */
export function useSetupItems(enabled: boolean) {
  const { subAccountId } = useSubAccount();
  const [items, setItems] = useState<SetupItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/readiness`, { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      const data = (await res.json()) as { items: SetupItem[] };
      setItems(data.items);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, [subAccountId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  return { items, failed, refreshing, load };
}

export function setupProgress(items: SetupItem[] | null) {
  const mine = (items ?? []).filter((i) => i.tab !== "");
  return {
    done: mine.filter((i) => i.ok).length,
    total: mine.length,
    requiredMissing: (items ?? []).filter((i) => i.required && !i.ok).length,
  };
}

function Step({ item, index, onGo }: { item: SetupItem; index: number; onGo: (t: SetupTarget) => void }) {
  return (
    <li className="flex items-start gap-3 p-3">
      {item.ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ls-ok)]" />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {index > 0 && <span className="mr-1.5 text-muted-foreground">{index}.</span>}
          {item.label}
          {item.required && !item.ok && (
            <span className="ml-2 rounded-full bg-[var(--ls-warn-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ls-warn)]">
              Required
            </span>
          )}
        </p>
        {!item.ok && <p className="mt-0.5 text-xs text-muted-foreground">{item.fix}</p>}
        {!item.ok && item.tab !== "" && (
          <Button size="sm" variant="outline" className="mt-2" onClick={() => onGo(item.tab as SetupTarget)}>
            {item.action}
          </Button>
        )}
      </div>
    </li>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label="Setup progress"
    >
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
    </div>
  );
}

/** A side panel that stays beside the page while the user works through the steps. */
export function SetupGuidePanel({
  items,
  failed,
  refreshing,
  onReload,
  onGo,
  onClose,
}: {
  items: SetupItem[] | null;
  failed: boolean;
  refreshing: boolean;
  onReload: () => void;
  onGo: (t: SetupTarget) => void;
  onClose: () => void;
}) {
  const { subAccountId } = useSubAccount();
  const storeKey = `fs-setup-panel-${subAccountId}`;
  const [tucked, setTucked] = useState(false);
  useEffect(() => {
    try {
      setTucked(localStorage.getItem(storeKey) === "tucked");
    } catch {
      // Stays open for this visit.
    }
  }, [storeKey]);
  const tuck = (value: boolean) => {
    setTucked(value);
    try {
      localStorage.setItem(storeKey, value ? "tucked" : "open");
    } catch {
      // Remembered for this visit only.
    }
  };

  const { done, total, requiredMissing } = setupProgress(items);
  const steps = (items ?? []).filter((i) => i.tab !== "");
  const host = (items ?? []).filter((i) => i.tab === "");
  const hostMissing = host.filter((i) => !i.ok);

  if (tucked) {
    return (
      <button
        type="button"
        onClick={() => tuck(false)}
        aria-label={`Open the setup guide, ${done} of ${total} steps done`}
        className="fixed bottom-24 right-0 z-40 flex items-center gap-1.5 rounded-l-xl border border-r-0 bg-card px-3 py-2 text-sm font-medium shadow-lg hover:bg-muted"
      >
        <ChevronLeft className="h-4 w-4" />
        Setup {done}/{total}
      </button>
    );
  }

  return (
    <aside
      aria-label="Setup guide"
      className="fixed bottom-4 right-0 top-20 z-40 flex w-80 max-w-[calc(100vw-1rem)] flex-col rounded-l-2xl border border-r-0 bg-card shadow-xl"
    >
      <div className="flex items-start justify-between gap-2 border-b p-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Setup guide</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {items ? `${done} of ${total} steps done` : "Checking…"}
          </p>
        </div>
        <div className="flex shrink-0 gap-0.5">
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Check again" onClick={onReload} disabled={refreshing}>
            <RefreshCw className={"h-3.5 w-3.5 " + (refreshing ? "animate-spin" : "")} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Tuck the setup guide to the side" onClick={() => tuck(true)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Close the setup guide" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {failed ? (
          <p className="text-sm text-destructive">Couldn&apos;t run the checks. Try again in a moment.</p>
        ) : !items ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
          </p>
        ) : (
          <>
            <ProgressBar done={done} total={total} />
            {requiredMissing > 0 && (
              <p className="mt-3 rounded-lg bg-[var(--ls-warn-bg)] p-3 text-xs text-[var(--ls-warn)]">
                {requiredMissing} required item{requiredMissing === 1 ? "" : "s"} still to do. Field Services won&apos;t work fully until
                {requiredMissing === 1 ? " it is" : " they are"} done.
              </p>
            )}
            <ul className="mt-3 divide-y rounded-lg border">
              {steps.map((i, n) => (
                <Step key={i.key} item={i} index={n + 1} onGo={onGo} />
              ))}
            </ul>
            {host.length > 0 && (
              <details className="mt-4" open={hostMissing.length > 0}>
                <summary className="cursor-pointer text-sm font-semibold">
                  Set by your host{hostMissing.length > 0 ? ` (${hostMissing.length} to do)` : ""}
                </summary>
                <p className="mt-1 text-xs text-muted-foreground">
                  These need keys or accounts on the deployment, and some live in Settings outside Field Services.
                </p>
                <ul className="mt-2 divide-y rounded-lg border">
                  {host.map((i) => (
                    <Step key={i.key} item={i} index={0} onGo={onGo} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
      <p className="border-t p-3 text-xs text-muted-foreground">Closed it? Turn it back on in Settings.</p>
    </aside>
  );
}
