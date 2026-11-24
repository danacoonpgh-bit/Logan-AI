"use client";

import { useCallback, useEffect, useState } from "react";

export type CrewPushState =
  | "checking"
  | "not-configured"
  | "unsupported"
  | "ios-needs-install"
  | "denied"
  | "ready"
  | "on";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function keyToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIos(): boolean {
  // An iPad in desktop mode calls itself a Mac, but a Mac has no touch screen.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

const STATE_EVENT = "crew-push-state";

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export async function dropThisDevice(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch("/api/field-portal/push", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch {
  }
}

export function useCrewPush() {
  const [state, setLocalState] = useState<CrewPushState>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The My day card and the Me tab each use this hook, so a change in one is shared with the other.
  const setState = useCallback((next: CrewPushState) => {
    setLocalState(next);
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: next }));
  }, []);
  useEffect(() => {
    const onState = (e: Event) => setLocalState((e as CustomEvent<CrewPushState>).detail);
    window.addEventListener(STATE_EVENT, onState);
    return () => window.removeEventListener(STATE_EVENT, onState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!VAPID_PUBLIC_KEY) return setState("not-configured");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        return setState(isIos() && !isStandalone() ? "ios-needs-install" : "unsupported");
      }
      if (Notification.permission === "denied") return setState("denied");
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) {
          if (!cancelled) setState("ready");
          return;
        }
        // Signing out removes the server copy but not the browser's, so make sure this device is registered.
        const res = await fetch("/api/field-portal/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent }),
        });
        if (!cancelled) setState(res.ok ? "on" : "ready");
      } catch {
        if (!cancelled) setState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setState]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "ready");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyToBytes(VAPID_PUBLIC_KEY),
        }));
      const res = await fetch("/api/field-portal/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent }),
      });
      if (!res.ok) throw new Error("Couldn't turn on alerts. Try again.");
      setState("on");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't turn on alerts.");
    } finally {
      setBusy(false);
    }
  }, [setState]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/field-portal/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      }
      setState("ready");
    } catch {
      setError("Couldn't turn off alerts.");
    } finally {
      setBusy(false);
    }
  }, [setState]);

  return { state, busy, error, enable, disable };
}
