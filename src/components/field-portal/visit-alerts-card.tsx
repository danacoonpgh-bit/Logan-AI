"use client";

import { Button } from "@/components/ui/button";
import { IosAddSteps, useDismissal } from "@/components/field-portal/install-card";
import { useCrewPush, type CrewPushState } from "@/components/field-portal/use-crew-push";

const TEXT: Record<Exclude<CrewPushState, "checking" | "not-configured" | "ios-needs-install">, string> = {
  unsupported: "This browser can't send alerts. Use Chrome on Android or Safari on iPhone.",
  denied: "Alerts are blocked for this app. Allow notifications in your phone settings, then come back.",
  ready: "Get an alert when you are given a new visit or one changes.",
  on: "Alerts are on for this device.",
};

/** The switch that lets this device receive visit alerts. Hidden where the business has not set alerts up. */
export function VisitAlertsCard() {
  const { state, busy, error, enable, disable } = useCrewPush();
  if (state === "checking" || state === "not-configured") return null;
  return (
    <section className="space-y-2">
      <h2 className="text-base font-medium">Visit alerts</h2>
      <div className="space-y-3 rounded-xl border p-4">
        {state === "ios-needs-install" ? (
          <>
            <p className="text-base text-muted-foreground">On iPhone, alerts only work once this app is on your Home Screen.</p>
            <IosAddSteps />
          </>
        ) : (
          <p className="text-base text-muted-foreground">{TEXT[state]}</p>
        )}
        {error && (
          <p role="alert" className="text-base text-destructive">
            {error}
          </p>
        )}
        {state === "ready" && (
          <Button className="h-12 w-full touch-manipulation text-base" disabled={busy} onClick={() => void enable()}>
            Turn on alerts
          </Button>
        )}
        {state === "on" && (
          <Button variant="outline" className="h-12 w-full touch-manipulation" disabled={busy} onClick={() => void disable()}>
            Turn off alerts
          </Button>
        )}
      </div>
    </section>
  );
}

const ALERTS_PROMPT_KEY = "field-alerts-prompt-dismissed";

/** A nudge on My day, shown until the device has alerts on or the person says not now. */
export function AlertsPrompt() {
  const { state, busy, error, enable } = useCrewPush();
  const { dismissed, dismiss } = useDismissal(ALERTS_PROMPT_KEY, 14);
  if (dismissed || state !== "ready") return null;
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="text-base font-medium">Get alerts for your visits</h2>
      <p className="text-base text-muted-foreground">We will let you know when you are given a visit or one changes.</p>
      {error && (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button className="h-12 flex-1 touch-manipulation text-base" disabled={busy} onClick={() => void enable()}>
          Turn on alerts
        </Button>
        <Button variant="outline" className="h-12 touch-manipulation" disabled={busy} onClick={dismiss}>
          Not now
        </Button>
      </div>
    </section>
  );
}
