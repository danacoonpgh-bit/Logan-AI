"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OtpInput } from "@/components/field-portal/otp-input";

const RESEND_SECONDS = 60;

export function LoginForm({ subAccountId }: { subAccountId: string }) {
  const [step, setStep] = useState<"identify" | "code">("identify");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function post(path: string, body: Record<string, string>) {
    const region = (navigator.language.split("-")[1] ?? "").toUpperCase();
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, country: /^[A-Z]{2}$/.test(region) ? region : undefined }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: res.ok, error: data.error };
  }

  async function sendCode() {
    if (busy || identifier.trim().length < 5) return;
    setBusy(true);
    setError("");
    try {
      const res = await post("/api/field-portal/otp/request", { identifier });
      if (!res.ok) {
        setError(res.error ?? "That didn't work.");
        return;
      }
      setCode("");
      setWait(RESEND_SECONDS);
      setStep("code");
    } catch {
      setError("No connection. Check your signal and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(value: string) {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setError("");
    try {
      const res = await post("/api/field-portal/otp/verify", { identifier, code: value });
      if (!res.ok) {
        setError(res.error ?? "That didn't work.");
        setCode("");
        return;
      }
      window.location.replace(`/field/${subAccountId}`);
    } catch {
      setError("No connection. Check your signal and try again.");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-base text-muted-foreground">
          {step === "identify"
            ? "We'll send you a 6-digit code."
            : "If that email is on your team, a 6-digit code is on its way."}
        </p>
      </div>
      {step === "identify" ? (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void sendCode();
          }}
        >
          <div className="space-y-2">
            <Input
              className="h-14 text-base"
              type="text"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              aria-label="Email address"
              aria-describedby="login-identity-hint"
            />
            <p id="login-identity-hint" className="text-sm text-muted-foreground">
              The email address your employer has for you
            </p>
          </div>
          {error && (
            <p role="alert" className="text-base text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="h-14 w-full touch-manipulation text-base"
            disabled={busy || identifier.trim().length < 5}
          >
            {busy && <Loader2 className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none" />}
            Send code
          </Button>
        </form>
      ) : (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void verify(code);
          }}
        >
          <OtpInput value={code} onChange={setCode} onComplete={(v) => void verify(v)} busy={busy} label="Sign-in code" autoFocus />
          {error && (
            <p role="alert" className="text-base text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="h-14 w-full touch-manipulation text-base" disabled={busy || code.length !== 6}>
            {busy && <Loader2 className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none" />}
            Sign in
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-12 w-full touch-manipulation text-base"
            disabled={busy || wait > 0}
            onClick={() => void sendCode()}
          >
            {wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
          </Button>
          <button
            type="button"
            className="min-h-11 w-full touch-manipulation text-base underline"
            onClick={() => {
              setStep("identify");
              setCode("");
              setError("");
            }}
          >
            Use a different email
          </button>
        </form>
      )}
    </div>
  );
}
