"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OtpInput } from "@/components/field-portal/otp-input";

type Stage = "loading" | "ready" | "invalid" | "done";

const RESEND_SECONDS = 60;

function inAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /FBAN|FBAV|Instagram|WhatsApp|GSA|Gmail|Line\/|Snapchat|Outlook/i.test(navigator.userAgent);
}

export function JoinForm() {
  const [token, setToken] = useState("");
  const [stage, setStage] = useState<Stage>("loading");
  const [business, setBusiness] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [wrongBrowser] = useState(inAppBrowser);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t") ?? "";
    setToken(t);
    if (!t) {
      setStage("invalid");
      return;
    }
    void fetch("/api/field-portal/invites/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("bad");
        const data = (await res.json()) as { subAccountId: string; businessName: string; workerName: string; sentTo: string };
        setWorkspace(data.subAccountId);
        setBusiness(data.businessName);
        setName(data.workerName);
        setTarget(data.sentTo);
        setStage("ready");
      })
      .catch(() => setStage("invalid"));
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function join(resend = false, code?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    if (resend) setOtp("");
    const otpValue = code ?? otp;
    try {
      const res = await fetch("/api/field-portal/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, otp: sentTo && !resend ? otpValue : undefined }),
      });
      const data = (await res.json()) as {
        error?: string;
        subAccountId?: string;
        needsOtp?: boolean;
        sentTo?: string;
        sent?: boolean;
      };
      if (res.status === 202 && data.needsOtp) {
        setSentTo(data.sentTo || target || "your email");
        setWait(RESEND_SECONDS);
        if (data.sent === false) setNotice("Wait a minute, then tap Resend code.");
        else if (resend) setNotice("We sent a new code.");
        return;
      }
      if (!res.ok) {
        setError(
          res.status === 429 || !sentTo
            ? (data.error ?? "That didn't work.")
            : "That didn't match. Check the code, or send a new one.",
        );
        setOtp("");
        return;
      }
      setStage("done");
      window.history.replaceState(null, "", window.location.pathname);
      const home = data.subAccountId || workspace;
      window.location.replace(home ? `/field/${home}` : "/field");
    } catch {
      setError("No connection. Check your signal and try again.");
      setOtp("");
    } finally {
      setBusy(false);
    }
  }

  if (stage === "loading") {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading your invite">
        <div className="h-8 w-2/3 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
        <div className="h-5 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
        <div className="h-14 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
      </div>
    );
  }

  if (stage === "invalid") {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">This invite isn&apos;t valid</h1>
        <p className="text-base text-muted-foreground">
          The link may have been used already or has expired. Ask your employer to send a new one.
        </p>
        <p className="text-base text-muted-foreground">Already joined? Open the crew app link your employer gave you.</p>
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div className="space-y-2" role="status">
        <h1 className="text-2xl font-semibold">You&apos;re in</h1>
        <p className="flex items-center gap-2 text-base text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Opening your day…
        </p>
      </div>
    );
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void join();
      }}
    >
      {wrongBrowser && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-base text-amber-700 dark:text-amber-400">
          You&apos;re in an in-app browser. For the best result, open this page in Safari (iPhone) or
          Chrome (Android) using the menu.
        </p>
      )}
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Join {business}</h1>
        <p className="text-base text-muted-foreground">
          {name ? `Hi ${name}. ` : ""}
          {sentTo
            ? `We sent a 6-digit code to ${sentTo}. Enter it to join.`
            : `We'll send a 6-digit code to ${target || "your email"} to confirm it's you.`}
        </p>
      </div>
      {sentTo && (
        <OtpInput
          value={otp}
          onChange={setOtp}
          onComplete={(v) => void join(false, v)}
          busy={busy}
          label="Code we sent you"
          autoFocus
        />
      )}
      {error && (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-base text-muted-foreground">
          {notice}
        </p>
      )}
      <Button
        type="submit"
        className="h-14 w-full touch-manipulation text-base"
        disabled={busy || (!!sentTo && otp.length !== 6)}
      >
        {busy && <Loader2 className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none" />}
        {sentTo ? "Join" : "Send me a code"}
      </Button>
      {sentTo && (
        <Button
          type="button"
          variant="ghost"
          className="h-12 w-full touch-manipulation text-base"
          disabled={busy || wait > 0}
          onClick={() => void join(true)}
        >
          {wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
        </Button>
      )}
    </form>
  );
}
