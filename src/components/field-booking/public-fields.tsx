"use client";

import { useEffect, useId, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type InputProps = Omit<React.ComponentProps<"input">, "id"> & { label: string; hint?: string };

/** A labelled text field: the label is tied to the input, so screen readers and taps on the label both work. */
export function Field({ label, hint, className, ...rest }: InputProps) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block text-sm text-muted-foreground">
        {label}
      </Label>
      <Input id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={cn("h-12 text-base", className)} {...rest} />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function FieldArea({ label, className, ...rest }: Omit<React.ComponentProps<"textarea">, "id"> & { label: string }) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block text-sm text-muted-foreground">
        {label}
      </Label>
      <Textarea id={id} className={cn("text-base", className)} {...rest} />
    </div>
  );
}

export function FieldSelect({
  label,
  options,
  className,
  ...rest
}: Omit<React.ComponentProps<"select">, "id"> & { label: string; options: [string, string][] }) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block text-sm text-muted-foreground">
        {label}
      </Label>
      <select
        id={id}
        className={cn(
          "h-12 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground",
          className,
        )}
        {...rest}
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Six boxes for a one-time code. Typing moves along, backspace moves back, a pasted code fills them all. */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
  length = 6,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  disabled?: boolean;
  length?: number;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  // After a wrong code or a resend the boxes come back to life empty, so put the cursor in the first one.
  const wasDisabled = useRef(false);
  useEffect(() => {
    if (wasDisabled.current && !disabled && value === "") refs.current[0]?.focus();
    wasDisabled.current = !!disabled;
  }, [disabled, value]);

  function removeAt(i: number) {
    if (value[i]) put(value.slice(0, i) + value.slice(i + 1), i);
    else if (i > 0) put(value.slice(0, i - 1) + value.slice(i), i - 1);
  }

  function put(next: string, focusAt: number) {
    onChange(next);
    refs.current[Math.min(focusAt, length - 1)]?.focus();
    if (next.length === length) onComplete?.(next);
  }

  return (
    <div role="group" aria-label={`${length}-digit code`} className="flex justify-between gap-2">
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={value[i] ?? ""}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          // The first box takes a whole code, because a phone's code suggestion fills it in one go.
          maxLength={i === 0 ? length : 1}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, "");
            // Some Android keyboards don't send a Backspace key, only an empty box.
            if (!raw) {
              removeAt(i);
              return;
            }
            if (raw.length >= 3 || (raw.length === 2 && value === "")) {
              put(raw.slice(0, length), Math.min(raw.length, length));
              return;
            }
            const d = raw.slice(-1);
            // Boxes fill in order, so a digit typed in a later box lands at the end.
            put(value.slice(0, Math.min(i, value.length)) + d + value.slice(i + 1), i + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              e.preventDefault();
              removeAt(i);
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const digits = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
            if (digits) put(digits, digits.length);
          }}
          onFocus={(e) => e.target.select()}
          className="h-14 w-full min-w-0 rounded-lg border border-input bg-transparent text-center text-2xl font-semibold outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
      ))}
    </div>
  );
}
