"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { callApi } from "@/components/field-services/field-ui";
import type { Visit } from "@/types/field-services";

/** A visit's checklist and customer sign-off, as the office sees them. Ticks and sign-off requests work like the crew's. */
export function VisitChecklistOffice({ visit, base }: { visit: Visit; base: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const items = visit.checklist ?? [];
  const signoff = visit.signoff ?? null;
  const finished = ["completed", "no_show", "cancelled"].includes(visit.status);
  const signed = signoff?.status === "signed";
  const showSignoff = visit.requireSignature === true || signoff !== null;
  const arrived = visit.status === "checked_in" || visit.status === "completed";
  const left = items.filter((i) => i.required && !i.done).length;
  const url = `${base}/visits/${visit.id}`;

  if (items.length === 0 && !showSignoff && finished) return null;

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    await fn();
    setBusy(null);
  }

  // Nothing to tick and no sign-off: a quiet link instead of an empty box.
  if (items.length === 0 && !showSignoff) {
    if (finished || signed) return null;
    return (
      <button
        type="button"
        disabled={busy !== null}
        className="self-start text-xs text-primary underline-offset-2 hover:underline disabled:opacity-60"
        onClick={() =>
          void run("refresh", async () => {
            const res = await callApi<{ added: number }>(`${url}/checklist`, "POST", { action: "refresh" });
            if (!res) return;
            toast[res.added > 0 ? "success" : "info"](
              res.added > 0
                ? `Added ${res.added} item${res.added === 1 ? "" : "s"}.`
                : "This service has no checklist yet. Add one with the Checklist button on the service in Services & areas.",
            );
          })
        }
      >
        Add checklist
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          Checklist{items.length > 0 ? ` ${items.filter((i) => i.done).length}/${items.length}` : ""}
        </span>
        {showSignoff && (
          <span
            className={
              signed
                ? "rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-700 dark:text-green-400"
                : signoff?.status === "pending"
                  ? "rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                  : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            }
          >
            {signed
              ? `Signed by ${signoff?.name || "the customer"}`
              : signoff?.status === "pending"
                ? "Waiting for the customer"
                : "Customer sign-off needed"}
          </span>
        )}
      </div>

      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={i.done}
                disabled={signed || busy !== null || visit.status === "cancelled"}
                onChange={(e) =>
                  void run(i.id, () =>
                    callApi(`${url}/checklist`, "POST", { action: "tick", itemId: i.id, done: e.target.checked }),
                  )
                }
                className="h-4 w-4 accent-primary"
                aria-label={i.text}
              />
              <span className={i.done ? "text-muted-foreground line-through" : ""}>
                {i.text}
                {i.required && !i.done ? <span className="ml-1.5 text-xs text-muted-foreground">Required</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {!finished && !signed && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              void run("refresh", async () => {
                const res = await callApi<{ added: number }>(`${url}/checklist`, "POST", { action: "refresh" });
                if (res) toast.success(res.added > 0 ? `Added ${res.added} item${res.added === 1 ? "" : "s"}.` : "Nothing new to add.");
              })
            }
          >
            Refresh from services
          </Button>
        )}
        {!signed && arrived && (showSignoff || items.length > 0) && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || (visit.requireChecklist === true && left > 0)}
            onClick={() =>
              void run("signoff", async () => {
                const res = await callApi<{ delivered: "sms" | "email" | null }>(`${url}/signoff`, "POST");
                if (!res) return;
                if (res.delivered) toast.success(`Sent to the customer by ${res.delivered === "sms" ? "text" : "email"}.`);
                else toast.error("Couldn't message the customer. Check they have a phone number or email.");
              })
            }
          >
            {signoff?.status === "pending" ? "Send the sign-off again" : "Ask the customer to confirm"}
          </Button>
        )}
      </div>
    </div>
  );
}
