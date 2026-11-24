"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { formatMinor, parseDecimalInput, unitToMinor, workspaceCurrencyOf } from "@/lib/field-services/money";
import { formatMinutes } from "@/lib/field-services/duration";
import type { FieldAddOn } from "@/types/field-services";

interface Draft {
  id: string | null;
  name: string;
  price: string;
  minutes: string;
  allServices: boolean;
  serviceIds: string[];
  active: boolean;
}

const EMPTY: Draft = { id: null, name: "", price: "", minutes: "", allServices: true, serviceIds: [], active: true };

export function AddOnsSection({ services }: { services: { id: string; name: string }[] }) {
  const { subAccountId } = useSubAccount();
  const { config } = useFieldConfig();
  const currency = workspaceCurrencyOf(config);
  const base = `/api/sub-accounts/${subAccountId}/field-services/add-ons`;
  const [addOns, setAddOns] = useState<FieldAddOn[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { addOns?: FieldAddOn[] } | null;
      setAddOns(res.ok ? (data?.addOns ?? []) : []);
    } catch {
      setAddOns([]);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(a: FieldAddOn) {
    setDraft({
      id: a.id,
      name: a.name,
      price: a.priceMinor > 0 ? formatMinor(currency, a.priceMinor) : "",
      minutes: a.extraMinutes > 0 ? String(a.extraMinutes) : "",
      allServices: a.allServices,
      serviceIds: a.serviceIds,
      active: a.active,
    });
  }

  async function save() {
    if (!draft) return;
    const price = draft.price.trim() ? parseDecimalInput(draft.price) : 0;
    if (price === null) {
      toast.error("Enter the price as a number, like 15 or 15.50.");
      return;
    }
    const minutes = draft.minutes.trim() ? Number.parseInt(draft.minutes, 10) : 0;
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 480) {
      toast.error("Extra time must be between 0 and 480 minutes.");
      return;
    }
    if (!draft.allServices && draft.serviceIds.length === 0) {
      toast.error("Choose at least one service, or tick All services.");
      return;
    }
    setBusy(true);
    const body = {
      name: draft.name,
      priceMinor: unitToMinor(currency, price),
      extraMinutes: minutes,
      allServices: draft.allServices,
      serviceIds: draft.allServices ? [] : draft.serviceIds,
      active: draft.active,
    };
    const res = draft.id ? await callApi(`${base}/${draft.id}`, "PATCH", body) : await callApi(base, "POST", body);
    setBusy(false);
    if (!res) return;
    toast.success(draft.id ? "Add-on saved." : "Add-on added.");
    setDraft(null);
    void load();
  }

  async function remove(a: FieldAddOn) {
    if (!window.confirm(`Delete the add-on "${a.name}"? Past bookings keep it.`)) return;
    if (await callApi(`${base}/${a.id}`, "DELETE")) void load();
  }

  function whichServices(a: FieldAddOn): string {
    if (a.allServices) return "All services";
    const names = a.serviceIds.map((id) => services.find((s) => s.id === id)?.name).filter(Boolean) as string[];
    return names.length ? names.join(", ") : "No services";
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Add-ons</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Optional extras customers can tick on the booking page, like an oven clean or a second room. One list
            for this workspace; choose which services each one goes with, here or in a service&apos;s own settings.
          </p>
        </div>
        <Button size="sm" onClick={() => setDraft({ ...EMPTY })}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> New add-on
        </Button>
      </div>

      {addOns === null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : addOns.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No add-ons yet.</p>
      ) : (
        <ul className="mt-4 divide-y rounded-lg border">
          {addOns.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className={"truncate text-sm font-medium " + (a.active ? "" : "text-muted-foreground line-through")}>
                  {a.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {formatMinor(currency, a.priceMinor)}
                  {a.extraMinutes > 0 ? ` · +${formatMinutes(a.extraMinutes)}` : ""} · {whichServices(a)}
                  {a.active ? "" : " · off"}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => edit(a)}>
                Edit
              </Button>
              <Button variant="outline" size="sm" onClick={() => void remove(a)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit add-on" : "New add-on"}</DialogTitle>
            <DialogDescription>
              The price is in {currency}. Extra time makes the visit, and the open times offered, that much longer.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Name</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Inside the oven"
                  disabled={busy}
                />
              </div>
              <div>
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Price ({currency})</Label>
                <Input
                  inputMode="decimal"
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                  placeholder="25"
                  disabled={busy}
                />
              </div>
              <div>
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Extra minutes</Label>
                <Input
                  inputMode="numeric"
                  value={draft.minutes}
                  onChange={(e) => setDraft({ ...draft, minutes: e.target.value.replace(/\D/g, "") })}
                  placeholder="0"
                  disabled={busy}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label className="block text-xs font-medium text-muted-foreground">Goes with</Label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.allServices}
                    onCheckedChange={(v) => setDraft({ ...draft, allServices: v === true })}
                  />
                  All services
                </label>
                {!draft.allServices && (
                  <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border p-2">
                    {services.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Add a service first.</p>
                    ) : (
                      services.map((s) => (
                        <label key={s.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={draft.serviceIds.includes(s.id)}
                            onCheckedChange={(v) =>
                              setDraft({
                                ...draft,
                                serviceIds:
                                  v === true ? [...draft.serviceIds, s.id] : draft.serviceIds.filter((x) => x !== s.id),
                              })
                            }
                          />
                          {s.name}
                        </label>
                      ))
                    )}
                  </div>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <Checkbox checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v === true })} />
                Offered on the booking page
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || !draft?.name.trim()}>
              {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Ticks for the add-ons that go with one service. Each tick saves straight away. */
export function ServiceAddOnPicker({ serviceId }: { serviceId: string }) {
  const { subAccountId } = useSubAccount();
  const base = `/api/sub-accounts/${subAccountId}/field-services/add-ons`;
  const [addOns, setAddOns] = useState<FieldAddOn[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(base, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { addOns?: FieldAddOn[] } | null) => live && setAddOns(d?.addOns ?? []))
      .catch(() => live && setAddOns([]));
    return () => {
      live = false;
    };
  }, [base]);

  if (addOns === null || addOns.length === 0) return null;

  async function toggle(addOn: FieldAddOn, on: boolean) {
    if (!addOns) return;
    const next = addOns.map((a) =>
      a.id === addOn.id
        ? { ...a, serviceIds: on ? [...a.serviceIds, serviceId] : a.serviceIds.filter((x) => x !== serviceId) }
        : a,
    );
    const ids = next.filter((a) => !a.allServices && a.serviceIds.includes(serviceId)).map((a) => a.id);
    setBusy(true);
    const res = await callApi(`${base}/by-service/${serviceId}`, "PUT", { addOnIds: ids });
    setBusy(false);
    if (res) setAddOns(next);
  }

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <p className="text-sm font-medium">Add-ons</p>
      <p className="text-xs text-muted-foreground">Extras customers can tick when they book this service.</p>
      {addOns.map((a) => (
        <label key={a.id} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={a.allServices || a.serviceIds.includes(serviceId)}
            disabled={busy || a.allServices}
            onCheckedChange={(v) => void toggle(a, v === true)}
          />
          <span>
            {a.name}
            {a.allServices ? <span className="text-xs text-muted-foreground"> (goes with all services)</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}
