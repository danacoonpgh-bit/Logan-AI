"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const LENGTH = 6;

/**
 * Six digit boxes over one real input, so paste, backspace and code autofill work like a plain field.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  busy,
  label,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Called once when the sixth digit arrives, by typing or paste. */
  onComplete?: (v: string) => void;
  busy?: boolean;
  label: string;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasBusy = useRef(false);
  const active = Math.min(value.length, LENGTH - 1);

  // A wrong code is cleared by the parent, so put the cursor back for the next try.
  useEffect(() => {
    if (wasBusy.current && !busy && value === "") inputRef.current?.focus();
    wasBusy.current = !!busy;
  }, [busy, value]);

  return (
    <div className="relative mx-auto w-full max-w-sm">
      <div className="grid grid-cols-6 gap-2" aria-hidden="true">
        {Array.from({ length: LENGTH }, (_, i) => {
          const isActive = focused && !busy && i === active;
          return (
            <div
              key={i}
              className={cn(
                "flex h-14 items-center justify-center rounded-lg border bg-background text-2xl font-semibold tabular-nums transition-colors",
                isActive && "border-primary ring-2 ring-primary/40",
                busy && "opacity-60",
              )}
            >
              {value[i] ?? (isActive ? <span className="h-6 w-px animate-pulse bg-foreground motion-reduce:animate-none" /> : "")}
            </div>
          );
        })}
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, "").slice(0, LENGTH);
          onChange(next);
          if (next.length === LENGTH && value.length < LENGTH) onComplete?.(next);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        readOnly={busy}
        autoFocus={autoFocus}
        aria-label={label}
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 outline-none"
      />
    </div>
  );
}
