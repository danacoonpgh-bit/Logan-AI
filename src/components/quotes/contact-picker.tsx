"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Contact } from "@/types/contacts";

/**
 * Modal contact picker: button shows the current contact, dialog has a search box
 * and A-Z list. Case-insensitive substring match on name/email/phone. Up/Down to
 * move, Enter to pick, Esc closes without changing.
 */

interface ContactPickerProps {
  contacts: Contact[];
  value: string;
  onChange: (contactId: string) => void;
  id?: string;
  placeholder?: string;
  /** Defaults to "Pick a recipient". */
  title?: string;
  /** Optional territory chip per row; only passed when scoping is on. */
  territoryLabel?: (contact: Contact) => string | null | undefined;
  /** Offer a New customer form that adds the person to Contacts and picks them. */
  allowNew?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function displayName(c: Contact): string {
  return c.name || c.email || c.phone || "(unnamed contact)";
}

function subtitle(c: Contact): string {
  // Secondary identifier so duplicate names can be told apart.
  if (c.name && c.email) return c.email;
  if (c.name && c.phone) return c.phone;
  if (c.email && c.phone) return c.phone;
  return "";
}

export function ContactPicker({
  contacts,
  value,
  onChange,
  id,
  placeholder = "Pick a contact…",
  title = "Pick a recipient",
  territoryLabel,
  allowNew = false,
}: ContactPickerProps) {
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () => contacts.find((c) => c.id === value) ?? null,
    [contacts, value],
  );

  function handlePick(contactId: string) {
    onChange(contactId);
    setOpen(false);
  }

  return (
    <>
      <button
        id={id}
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {selected ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate font-medium">{displayName(selected)}</span>
            {subtitle(selected) && (
              <span className="truncate text-[11px] text-muted-foreground">
                · {subtitle(selected)}
              </span>
            )}
          </span>
        ) : (
          <span className="truncate text-muted-foreground">{placeholder}</span>
        )}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      <ContactPickerDialog
        open={open}
        onOpenChange={setOpen}
        contacts={contacts}
        value={value}
        onPick={handlePick}
        title={title}
        territoryLabel={territoryLabel}
        allowNew={allowNew}
      />
    </>
  );
}

function ContactPickerDialog({
  open,
  onOpenChange,
  contacts,
  value,
  onPick,
  title,
  territoryLabel,
  allowNew,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  contacts: Contact[];
  value: string;
  onPick: (id: string) => void;
  title: string;
  territoryLabel?: (contact: Contact) => string | null | undefined;
  allowNew: boolean;
}) {
  const { subAccountId } = useSubAccount();
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  // Reset on open and autofocus the search.
  useEffect(() => {
    if (open) {
      setQuery("");
      setAdding(false);
      setHighlighted(0);
      // Defer so it lands after the Dialog's own focus handling.
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const sorted = useMemo(
    () =>
      [...contacts].sort((a, b) =>
        displayName(a).localeCompare(displayName(b), undefined, {
          sensitivity: "base",
        }),
      ),
    [contacts],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return sorted;
    return sorted.filter((c) => {
      const name = (c.name ?? "").toLowerCase();
      const email = (c.email ?? "").toLowerCase();
      const phone = (c.phone ?? "").toLowerCase();
      return name.includes(term) || email.includes(term) || phone.includes(term);
    });
  }, [sorted, query]);

  useEffect(() => {
    if (highlighted >= filtered.length) {
      setHighlighted(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, highlighted]);

  // Keep the highlighted row in view during arrow-key nav.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const child = listRef.current.children[highlighted] as HTMLElement | undefined;
    child?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && filtered[highlighted]) {
      e.preventDefault();
      onPick(filtered[highlighted].id);
    }
  }

  function startAdding() {
    const typed = query.trim();
    setForm({
      name: typed && !typed.includes("@") && !/^[\d\s+()-]+$/.test(typed) ? typed : "",
      email: typed.includes("@") ? typed : "",
      phone: /^[\d\s+()-]{6,}$/.test(typed) ? typed : "",
    });
    setAdding(true);
  }

  async function saveNew() {
    const name = form.name.trim();
    const email = form.email.trim().toLowerCase();
    const phone = form.phone.trim();
    if (!name) return toast.error("Enter their name.");
    if (!email && !phone) return toast.error("Enter an email or a mobile number so you can reach them.");
    if (email && !EMAIL_RE.test(email)) return toast.error("Enter a valid email address.");
    // Same email as a contact already here: use that one instead of making a duplicate.
    const same = email ? contacts.find((c) => (c.email ?? "").trim().toLowerCase() === email) : undefined;
    if (same) {
      toast.success(`${displayName(same)} is already in your contacts, so they are selected.`);
      onPick(same.id);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subAccountId, name, email, phone, source: "other" }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error ?? "Could not add the customer.");
      toast.success(`${name} added to your contacts.`);
      onPick(data.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the customer.");
    } finally {
      setSaving(false);
    }
  }

  if (adding) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New customer</DialogTitle>
            <DialogDescription>They are added to your main Contacts list, and picked here.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">Full name</Label>
              <Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Email</Label>
                <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div>
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Mobile</Label>
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">An email or a mobile is needed. You add the project address on the project.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={saving} onClick={() => setAdding(false)}>
                Back
              </Button>
              <Button disabled={saving} onClick={() => void saveNew()}>
                {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />} Add customer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Search by name, email, or phone. {sorted.length} contact
            {sorted.length === 1 ? "" : "s"} in this sub-account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={listboxId}
              aria-autocomplete="list"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlighted(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Type to filter…"
              autoComplete="off"
              spellCheck={false}
              className="h-9 w-full rounded-lg border border-input bg-background pl-8 pr-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>

          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
              <Users className="h-5 w-5 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                No contacts match &ldquo;{query.trim()}&rdquo;.
              </p>
              {allowNew && (
                <Button size="sm" onClick={startAdding}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Add as a new customer
                </Button>
              )}
            </div>
          ) : (
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              className="max-h-80 overflow-y-auto rounded-lg border"
            >
              {filtered.map((c, i) => {
                const isHighlighted = i === highlighted;
                const isSelected = c.id === value;
                const name = displayName(c);
                const sub = subtitle(c);
                const terr = territoryLabel?.(c);
                return (
                  <li
                    key={c.id}
                    role="option"
                    aria-selected={isSelected}
                    onMouseDown={(e) => {
                      // Prevent input blur from racing the click.
                      e.preventDefault();
                      onPick(c.id);
                    }}
                    onMouseEnter={() => setHighlighted(i)}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-3 border-b px-3 py-2 text-sm last:border-0",
                      isHighlighted && "bg-muted",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{name}</p>
                      {sub && (
                        <p className="truncate text-[11px] text-muted-foreground">
                          {sub}
                        </p>
                      )}
                    </div>
                    {terr && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {terr}
                      </span>
                    )}
                    {isSelected && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">
              ↑ ↓ to navigate · Enter to pick · Esc to close
            </p>
            {allowNew && filtered.length > 0 && (
              <Button size="sm" variant="outline" onClick={startAdding}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> New customer
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
