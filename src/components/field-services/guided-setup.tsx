"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TabsTrigger } from "@/components/ui/tabs";
import { useSubAccount } from "@/context/sub-account-context";
import { useFieldData } from "@/components/field-services/field-data";
import type { FieldServicesConfig } from "@/types/field-services";

/** The tab each step of guided setup works on. */
const STAGE_TAB = { 1: "setup", 2: "workers", 3: "booking" } as const;
/** What a new workspace can open at each step. Everything else waits. */
const OPEN_AT: Record<1 | 2 | 3, string[]> = {
  1: ["setup"],
  2: ["setup", "workers"],
  3: ["setup", "workers", "booking", "portal", "settings"],
};
const WHY_LOCKED: Record<1 | 2 | 3, string> = {
  1: "Add your first service to unlock this.",
  2: "Finish the staff step to unlock this.",
  3: "Finish setup to unlock this.",
};

interface Guided {
  active: boolean;
  stage: 1 | 2 | 3;
  /** Why a tab cannot be opened yet, or null when it can. */
  lockReason: (tab: string) => string | null;
  patch: (body: Record<string, boolean>, done?: string) => Promise<void>;
}

const Ctx = createContext<Guided | null>(null);

function useGuided(): Guided {
  const g = useContext(Ctx);
  if (!g) throw new Error("useGuided must be used inside GuidedSetupProvider");
  return g;
}

/**
 * Walks a new workspace through setup in order: services and areas, staff, online booking. Other tabs are greyed out.
 * Workspaces that already have services or work never see it, and an admin can switch it off.
 */
export function GuidedSetupProvider({
  config,
  reload,
  isAdmin,
  onTab,
  children,
}: {
  config: FieldServicesConfig | null;
  reload: () => void;
  isAdmin: boolean;
  onTab: (tab: string) => void;
  children: ReactNode;
}) {
  const { subAccountId } = useSubAccount();
  const { services, jobs, requests, visits, loaded } = useFieldData();
  const url = `/api/sub-accounts/${subAccountId}/field-services/config`;

  const hasWork = jobs.length > 0 || requests.length > 0 || visits.length > 0;
  const serviceCount = services.filter((s) => s.active !== false).length;
  const started = config?.guidedSetupStarted === true;
  const finished = config?.guidedSetupStaffDone === true && config?.guidedSetupBookingDone === true;
  const eligible = isAdmin && loaded && !!config && config.guidedSetupSkipped !== true && !hasWork && (started || serviceCount === 0);
  const active = eligible && !finished;
  const stage: 1 | 2 | 3 = serviceCount === 0 ? 1 : config?.guidedSetupStaffDone !== true ? 2 : 3;

  const patch = useCallback(
    async (body: Record<string, boolean>, done?: string) => {
      try {
        const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error("bad status");
        if (done) toast.success(done);
        reload();
      } catch {
        toast.error("That didn't save. Try again.");
      }
    },
    [url, reload],
  );

  // A workspace that starts from nothing is remembered as in guided setup, so adding a first service does not end it.
  const marked = useRef(false);
  useEffect(() => {
    if (!eligible || started || marked.current) return;
    marked.current = true;
    void fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guidedSetupStarted: true }) })
      .then(() => reload())
      .catch(() => {});
  }, [eligible, started, url, reload]);

  // Each step opens its own tab, and finishing lands on Home.
  const shown = useRef<string>("");
  useEffect(() => {
    const key = active ? `s${stage}` : "free";
    if (shown.current === key) return;
    const was = shown.current;
    shown.current = key;
    if (active) onTab(STAGE_TAB[stage]);
    else if (was.startsWith("s")) onTab("home");
  }, [active, stage, onTab]);

  const value = useMemo<Guided>(
    () => ({
      active,
      stage,
      lockReason: (tab) => (active && !OPEN_AT[stage].includes(tab) ? WHY_LOCKED[stage] : null),
      patch,
    }),
    [active, stage, patch],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** A tab that greys out and says why while guided setup has not reached it. */
export function GatedTab({ value, children }: { value: string; children: ReactNode }) {
  const { lockReason } = useGuided();
  const reason = lockReason(value);
  if (!reason) return <TabsTrigger value={value}>{children}</TabsTrigger>;
  return (
    <span title={reason} className="inline-flex h-full cursor-not-allowed">
      <TabsTrigger value={value} disabled>
        <Lock className="h-3 w-3" aria-hidden />
        {children}
      </TabsTrigger>
    </span>
  );
}

/** Hides what should not show while guided setup is running. */
export function HideWhileGuided({ children }: { children: ReactNode }) {
  const { active } = useGuided();
  return active ? null : <>{children}</>;
}

const STEPS: Record<1 | 2 | 3, { title: string; body: string }> = {
  1: {
    title: "Step 1 of 3: Add what you offer",
    body: "Add your first service (a name, a price and how long it takes) and the areas you cover. As soon as there is a service you move on to your staff.",
  },
  2: {
    title: "Step 2 of 3: Check your staff",
    body: "Everyone in your workspace is already on the list. Open each person to set their working hours and the services and areas they cover, and add anyone who has no login. Customers can only book times when people have hours.",
  },
  3: {
    title: "Step 3 of 3: Take bookings online (optional)",
    body: "Turn on the booking page so customers can book or ask for a time. A service needs Bookable online switched on. Settings has your message and timesheet options. You can come back to all of this later.",
  },
};

export function GuidedSetupBanner() {
  const { active, stage, patch } = useGuided();
  const [busy, setBusy] = useState(false);
  if (!active) return null;
  const step = STEPS[stage];
  const run = async (body: Record<string, boolean>, done?: string) => {
    setBusy(true);
    await patch(body, done);
    setBusy(false);
  };
  return (
    <section aria-label="Guided setup" className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
      <p className="text-sm font-semibold">{step.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {stage === 2 && (
          <Button size="sm" disabled={busy} onClick={() => void run({ guidedSetupStaffDone: true })}>
            Staff are ready, next step
          </Button>
        )}
        {stage === 3 && (
          <>
            <Button size="sm" disabled={busy} onClick={() => void run({ guidedSetupBookingDone: true }, "Setup finished. Everything is unlocked.")}>
              Finish setup
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ guidedSetupBookingDone: true }, "Setup finished. You can turn on online booking any time.")}
            >
              Skip online booking for now
            </Button>
          </>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void run({ guidedSetupSkipped: true }, "Guided setup is off. Every tab is open.")}
          className="ml-auto text-xs text-muted-foreground underline"
        >
          Skip guided setup and show every tab
        </button>
      </div>
    </section>
  );
}
