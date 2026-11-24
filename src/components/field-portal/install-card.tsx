"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type InstallMode = "checking" | "installed" | "desktop" | "ios" | "prompt" | "manual";

const INSTALL_DISMISS_KEY = "field-install-card-dismissed";
const DAY_MS = 24 * 60 * 60 * 1000;

// The browser fires this once, often before any card has mounted, so it is held at module level.
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installed = true;
    notify();
  });
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** A computer with a mouse. Installing is a phone thing, so nothing asks for it here. */
function isDesktop(): boolean {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return false;
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return false;
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function detectMode(): InstallMode {
  if (installed || isStandalone()) return "installed";
  if (isDesktop()) return "desktop";
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  return deferredPrompt ? "prompt" : "manual";
}

export function useInstall() {
  const [mode, setMode] = useState<InstallMode>("checking");

  useEffect(() => {
    const sync = () => setMode(detectMode());
    sync();
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const install = useCallback(async () => {
    const event = deferredPrompt;
    if (!event) return;
    try {
      await event.prompt();
      const choice = await event.userChoice;
      if (choice.outcome === "accepted") installed = true;
    } catch {
      // The browser refuses a second prompt on the same event.
    }
    deferredPrompt = null;
    notify();
  }, []);

  return { mode, install };
}

/** True once the stored dismissal is older than `days`. Starts true so a dismissed card never flashes. */
export function useDismissal(key: string, days: number) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      const at = Number(localStorage.getItem(key));
      setDismissed(Boolean(at) && Date.now() - at < days * DAY_MS);
    } catch {
      setDismissed(false);
    }
  }, [key, days]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(key, String(Date.now()));
    } catch {
      // Private mode: the card just comes back next visit.
    }
  }, [key]);

  return { dismissed, dismiss };
}

export function IosAddSteps() {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
      <li>Tap the Share button in Safari.</li>
      <li>Choose Add to Home Screen.</li>
      <li>Open the app from your Home Screen.</li>
    </ol>
  );
}

function ManualSteps() {
  return (
    <p className="text-sm text-muted-foreground">
      Open your browser menu and choose Install app or Add to Home screen.
    </p>
  );
}

/** Dismissible install prompt for My day. Hidden once installed, and for 14 days after a dismissal. */
export function InstallCard() {
  const { mode, install } = useInstall();
  const { dismissed, dismiss } = useDismissal(INSTALL_DISMISS_KEY, 14);

  if (dismissed || (mode !== "ios" && mode !== "prompt")) return null;

  return (
    <section className="relative space-y-3 rounded-xl border p-4 pr-14">
      <h2 className="text-base font-medium">Put this app on your phone</h2>
      <p className="text-base text-muted-foreground">Open it in one tap, even with a weak signal.</p>
      {mode === "ios" ? (
        <IosAddSteps />
      ) : (
        <Button className="h-12 w-full touch-manipulation text-base" onClick={() => void install()}>
          <Download className="mr-2 h-5 w-5" aria-hidden="true" />
          Install app
        </Button>
      )}
      <button
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className="absolute right-1 top-1 flex h-11 w-11 touch-manipulation items-center justify-center rounded-lg text-muted-foreground active:opacity-60"
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
    </section>
  );
}

/** Permanent install section for the Me tab. Renders nothing once the app is installed. */
export function InstallSection() {
  const { mode, install } = useInstall();
  if (mode === "checking" || mode === "installed" || mode === "desktop") return null;

  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="text-base font-medium">Install app</h2>
      {mode === "ios" && <IosAddSteps />}
      {mode === "prompt" && (
        <>
          <p className="text-base text-muted-foreground">Add this app to your phone to open it in one tap.</p>
          <Button className="h-12 w-full touch-manipulation text-base" onClick={() => void install()}>
            <Download className="mr-2 h-5 w-5" aria-hidden="true" />
            Install app
          </Button>
        </>
      )}
      {mode === "manual" && <ManualSteps />}
    </section>
  );
}
