"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callApi } from "@/components/field-services/field-ui";
import { formatMinor, parseDecimalInput, unitToMinor } from "@/lib/field-services/money";
import type { RateCard } from "@/types/field-services";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { workspaceCurrencyOf } from "@/lib/field-services/money";
import { workerTerms } from "@/lib/field-services/terms";

interface Draft {
  id: string | null;
  name: string;
  currency: string;
  hourly: string;
  day: string;
}

const EMPTY: Draft = { id: null, name: "", currency: "USD", hourly: "", day: "" };

function describe(card: RateCard): string {
  const parts: string[] = [];
  if (card.hourlyRateMinor > 0) parts.push(`${formatMinor(card.currency, card.hourlyRateMinor)} / hour`);
  if (card.dayRateMinor) parts.push(`${formatMinor(card.currency, card.dayRateMinor)} / day`);
  return parts.join(" · ");
}

export function RateCardsSection({
  cards,
  loaded,
  workerCounts,
  onChanged,
}: {
  cards: RateCard[];
  loaded: boolean;
  workerCounts: Record<string, number>;
  onChanged: () => void;
}) {
  const { subAccountId } = useSubAccount();
  const { config } = useFieldConfig();
  const wsCur = workspaceCurrencyOf(config);
  const wt = workerTerms(config);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/sub-accounts/${subAccountId}/field-services/rate-cards`;

  function startEdit(card: RateCard) {
    setDraft({
      id: card.id,
      name: card.name,
      currency: card.currency,
      hourly: card.hourlyRateMinor > 0 ? formatMinor(card.currency, card.hourlyRateMinor) : "",
      day: card.dayRateMinor ? formatMinor(card.currency, card.dayRateMinor) : "",
    });
  }

  function toMinor(text: string, currency: string, label: string): number | null | undefined {
    if (!text.trim()) return null;
    const n = parseDecimalInput(text);
    if (n === null) {
      toast.error(`Enter the ${label} as a number, like 85 or 85.50.`);
      return undefined;
    }
    return unitToMinor(currency, n);
  }

  async function save() {
    if (!draft) return;
    const currency = config?.currency ? wsCur : draft.currency || wsCur;
    const hourly = toMinor(draft.hourly, currency, "hourly rate");
    const day = toMinor(draft.day, currency, "day rate");
    if (hourly === undefined || day === undefined) return;
    setBusy(true);
    const body = {
      name: draft.name,
      currency,
      hourlyRateMinor: hourly ?? 0,
      dayRateMinor: day,
    };
    const res = draft.id
      ? await callApi(`${base}/${draft.id}`, "PATCH", body)
      : await callApi(base, "POST", body);
    setBusy(false);
    if (!res) return;
    toast.success(draft.id ? "Rate card saved." : "Rate card added.");
    setDraft(null);
    onChanged();
  }

  async function setArchived(card: RateCard, archived: boolean) {
    const res = await callApi(`${base}/${card.id}`, "PATCH", { archived });
    if (res) onChanged();
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Rate cards</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            What each role is charged out at. Give every {wt.worker} a card below, then invoices price
            their logged time from it. Changing a card only affects invoices drafted after.
            {wt.Workers} keep using an archived card until you give them another.
          </p>
        </div>
        <Button size="sm" onClick={() => setDraft({ ...EMPTY })}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add rate card
        </Button>
      </div>

      {!loaded ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : cards.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No rate cards yet. Add one for each role, like Electrician or Apprentice.
        </p>
      ) : (
        <ul className="mt-4 divide-y rounded-lg border">
          {cards.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p
                  className={
                    "truncate text-sm font-medium " + (c.archived ? "text-muted-foreground line-through" : "")
                  }
                >
                  {c.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {describe(c)}
                  {workerCounts[c.id] ? ` · ${workerCounts[c.id]} ${workerCounts[c.id] === 1 ? wt.worker : wt.workers}` : ""}
                  {c.archived ? " · archived" : ""}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => startEdit(c)}>
                Edit
              </Button>
              <Button variant="outline" size="sm" onClick={() => void setArchived(c, !c.archived)}>
                {c.archived ? "Restore" : "Archive"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit rate card" : "New rate card"}</DialogTitle>
            <DialogDescription>
              Set an hourly rate, a day rate, or both. With both, hourly time is capped at the day
              rate for one person on one day.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Role name</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Electrician"
                  disabled={busy}
                />
              </div>
              <div>
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Hourly rate ({wsCur})</Label>
                <Input
                  inputMode="decimal"
                  value={draft.hourly}
                  onChange={(e) => setDraft({ ...draft, hourly: e.target.value })}
                  placeholder="85"
                  disabled={busy}
                />
              </div>
              <div>
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Day rate ({wsCur})</Label>
                <Input
                  inputMode="decimal"
                  value={draft.day}
                  onChange={(e) => setDraft({ ...draft, day: e.target.value })}
                  placeholder="600"
                  disabled={busy}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={
                busy ||
                !draft?.name.trim() ||
                (!draft.hourly.trim() && !draft.day.trim())
              }
            >
              {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
