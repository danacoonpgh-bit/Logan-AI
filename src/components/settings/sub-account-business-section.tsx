"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Store } from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddressFields, EMPTY_ADDRESS, addressIsEmpty } from "@/components/field-services/field-ui";
import type { ServiceAddress } from "@/types/field-services";
import type { BusinessDetails } from "@/types/tenancy";

const FIELDS = [
  { key: "name", label: "Business name", placeholder: "A1 Plumbing", type: "text" },
  { key: "phone", label: "Phone number", placeholder: "+61 3 5550 1234", type: "text" },
  { key: "email", label: "Email", placeholder: "hello@a1plumbing.com", type: "email" },
  { key: "website", label: "Website", placeholder: "https://a1plumbing.com", type: "text" },
] as const;

type Key = (typeof FIELDS)[number]["key"];

/** The business as customers see it. Optional; the Online booking tab chooses which parts show on the booking page. */
export function SubAccountBusinessSection() {
  const { subAccount, subAccountId, isAdmin } = useSubAccount();
  const [values, setValues] = useState<Record<Key, string>>({ name: "", phone: "", email: "", website: "" });
  const [location, setLocation] = useState<ServiceAddress>(EMPTY_ADDRESS);
  const [saving, setSaving] = useState(false);

  // Keyed on the saved values, not the doc object, so unrelated live updates don't wipe what is being typed.
  const saved = JSON.stringify(subAccount?.businessDetails ?? null);
  useEffect(() => {
    const d = JSON.parse(saved) as BusinessDetails | null;
    setValues({ name: d?.name ?? "", phone: d?.phone ?? "", email: d?.email ?? "", website: d?.website ?? "" });
    setLocation({ ...EMPTY_ADDRESS, ...(d?.address ?? {}) });
  }, [saved]);

  if (!isAdmin) return null;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!addressIsEmpty(location) && (!location.line1.trim() || !location.postcode.trim())) {
      toast.error("Enter the street address and postcode, or leave the address blank.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessDetails: {
            ...values,
            address: addressIsEmpty(location) ? null : location,
          },
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save.");
      toast.success("Business details saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <Store className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Business details</h2>
          <p className="text-xs text-muted-foreground">
            The business as customers see it. Optional. The Field Services booking page can show these in its footer, and the
            address is where new staff start their day unless you change it.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        {FIELDS.slice(0, 1).map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={`business-${f.key}`}>{f.label}</Label>
            <Input
              id={`business-${f.key}`}
              type={f.type}
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
            />
          </div>
        ))}
        <div className="space-y-1.5">
          <Label>Address</Label>
          <AddressFields value={location} onChange={setLocation} />
        </div>
        {FIELDS.slice(1).map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={`business-${f.key}`}>{f.label}</Label>
            <Input
              id={`business-${f.key}`}
              type={f.type}
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
            />
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground">Leave any field blank to leave it out.</p>
        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </section>
  );
}
