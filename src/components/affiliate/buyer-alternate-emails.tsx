"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";

/** Extra emails a buyer set up under, editable inline on the Buyer Status row. */
export function BuyerAlternateEmails({
  purchaseId,
  initial,
}: {
  purchaseId: string;
  initial: string[];
}) {
  const [emails, setEmails] = useState(initial);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(action: "add" | "remove", email: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/agency/affiliates/alternate-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseId, action, email }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        alternateEmails?: string[];
      };
      if (!res.ok || !data.alternateEmails) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      setEmails(data.alternateEmails);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const value = draft.trim();
    if (!value) {
      setAdding(false);
      return;
    }
    if (await send("add", value)) {
      setDraft("");
      setAdding(false);
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {emails.map((e) => (
        <span
          key={e}
          title="Also set up under this email"
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
        >
          {e}
          <button
            type="button"
            disabled={busy}
            onClick={() => void send("remove", e)}
            aria-label={`Remove ${e}`}
            className="rounded hover:text-foreground disabled:opacity-50"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          type="email"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
          onBlur={() => void submit()}
          placeholder="other@email.com"
          aria-label="Additional email"
          className="h-6 w-44 rounded-md border bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3 w-3" aria-hidden />
          {emails.length === 0 ? "Add email" : "Add"}
        </button>
      )}
    </div>
  );
}
