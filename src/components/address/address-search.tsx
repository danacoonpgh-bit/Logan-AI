"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AddressSuggestion } from "@/types/address";

/**
 * Type a street address, pick a suggestion, get the whole address filled in. It shows nothing when suggestions
 * aren't set up, so the plain fields around it keep working.
 */
export function AddressSearch({
  onPick,
  country,
  disabled,
  label = "Find the address",
  placeholder = "Start typing the street address",
  className,
  large,
}: {
  onPick: (s: AddressSuggestion) => void;
  /** Two-letter country to look in first. Without it all four markets are searched. */
  country?: string;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  className?: string;
  /** The bigger touch-friendly look of the public booking page. */
  large?: boolean;
}) {
  const [text, setText] = useState("");
  const [items, setItems] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [off, setOff] = useState(false);
  const seq = useRef(0);
  const timer = useRef<number | null>(null);
  const id = useId();

  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  function search(value: string) {
    setText(value);
    setActive(-1);
    if (timer.current) window.clearTimeout(timer.current);
    if (value.trim().length < 3) {
      setItems([]);
      setOpen(false);
      return;
    }
    timer.current = window.setTimeout(async () => {
      const mine = ++seq.current;
      try {
        const params = new URLSearchParams({ q: value.trim() });
        if (country) params.set("country", country);
        const res = await fetch(`/api/address/suggest?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { suggestions: AddressSuggestion[]; configured?: boolean };
        if (mine !== seq.current) return;
        if (data.configured === false) return setOff(true);
        setItems(data.suggestions);
        setOpen(data.suggestions.length > 0);
      } catch {
        // the typed fields still work
      }
    }, 250);
  }

  function pick(s: AddressSuggestion) {
    onPick(s);
    setText("");
    setItems([]);
    setOpen(false);
  }

  if (off) return null;

  return (
    <div className={cn("relative", className)}>
      <label htmlFor={id} className={cn("block text-muted-foreground", large ? "mb-1.5 text-sm" : "mb-1 text-xs font-medium")}>
        {label}
      </label>
      <div className="relative">
        <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          className={cn("pl-9", large && "h-12 text-base")}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          onChange={(e) => search(e.target.value)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onFocus={() => items.length > 0 && setOpen(true)}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && active >= 0) {
              e.preventDefault();
              pick(items[active]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover text-sm text-popover-foreground shadow-md"
        >
          {items.map((s, i) => (
            <li
              key={s.id}
              role="option"
              aria-selected={i === active}
              className={cn("cursor-pointer px-3 py-2", i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
