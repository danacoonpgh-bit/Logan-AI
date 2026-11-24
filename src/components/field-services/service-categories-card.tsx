"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { DEFAULT_SERVICE_CATEGORY, MAX_SERVICE_CATEGORIES, serviceCategoryList } from "@/lib/field-services/service-categories";

/** The categories a service can be put in. They group services on the booking page. */
export function ServiceCategoriesCard() {
  const { subAccountId } = useSubAccount();
  const { config, reload } = useFieldConfig();
  const [list, setList] = useState<string[]>([DEFAULT_SERVICE_CATEGORY]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const filled = useRef(false);

  useEffect(() => {
    if (!config || filled.current) return;
    filled.current = true;
    setList(serviceCategoryList(config));
  }, [config]);

  if (!config) return null;
  const saved = serviceCategoryList(config);
  const dirty = JSON.stringify(list) !== JSON.stringify(saved);

  function add() {
    const name = draft.trim().replace(/\s+/g, " ");
    if (!name) return;
    if (list.some((c) => c.toLowerCase() === name.toLowerCase())) {
      toast.error("That category is already in the list.");
      return;
    }
    setList((cur) => [...cur, name]);
    setDraft("");
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceCategories: list }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "That didn't save.");
        return;
      }
      toast.success("Saved.");
      filled.current = false;
      reload();
    } catch {
      toast.error("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <h2 className="text-base font-semibold">Service categories</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The list you pick from when adding a service. On the booking page, services are grouped under their category. Default has no
        heading. A service in a category you remove moves to Default.
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {list.map((c) => (
          <li key={c} className="flex items-center gap-1 rounded-full border bg-muted/30 py-1 pl-3 pr-1 text-sm">
            {c}
            {c === DEFAULT_SERVICE_CATEGORY ? (
              <span className="pr-2 text-xs text-muted-foreground">always on</span>
            ) : (
              <button
                type="button"
                aria-label={`Remove ${c}`}
                className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setList((cur) => cur.filter((x) => x !== c))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {list.length < MAX_SERVICE_CATEGORIES && (
        <div className="mt-3 flex max-w-sm gap-2">
          <Input
            value={draft}
            maxLength={40}
            placeholder="Plumbing"
            aria-label="New category"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={add} disabled={!draft.trim()}>
            Add
          </Button>
        </div>
      )}
      <div className="mt-4">
        <Button type="button" disabled={busy || !dirty} onClick={() => void save()}>
          {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          Save categories
        </Button>
      </div>
    </section>
  );
}
