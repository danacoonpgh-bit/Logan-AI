"use client";

import { useEffect, useState } from "react";
import { TRAVEL_CHOICES, travelLabel } from "@/lib/field-services/travel";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ServiceAddOnPicker } from "@/components/field-services/add-ons-section";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ProductImagesField,
  uploadProductImage,
  type StagedImage,
} from "@/components/products/product-images-field";
import { ServiceMessages } from "@/components/field-services/visit-messages-card";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { workspaceCurrencyOf } from "@/lib/field-services/money";
import { serviceCategoryList, serviceCategoryOf } from "@/lib/field-services/service-categories";
import { BILLING_TYPE_LABELS, type JobBillingType } from "@/types/field-services";
import type { Product } from "@/types/products";

const SWATCHES = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#dc2626", "#0891b2", "#ca8a04", "#64748b"];

function SectionHead({ children }: { children: React.ReactNode }) {
  return <h3 className="border-b pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

/** Add or edit one service: what customers read on the booking page, the price and length, and whether it can be booked online. */
export function ServiceDialog({
  open,
  onOpenChange,
  subAccountId,
  service,
  bookable,
  canChangeBookable,
  onBookable,
  onChecklist,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subAccountId: string;
  /** Null while adding a new service. */
  service: Product | null;
  bookable: boolean;
  canChangeBookable: boolean;
  onBookable: (productId: string, on: boolean) => Promise<boolean>;
  onChecklist: (service: Product) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [rate, setRate] = useState("");
  const [staffNeeded, setStaffNeeded] = useState("1");
  const [currency, setCurrency] = useState("USD");
  const [hoursLong, setHoursLong] = useState("");
  const [leadHours, setLeadHours] = useState("");
  const [travelMins, setTravelMins] = useState("");
  const [variants, setVariants] = useState<{ id: string; name: string; mins: string; price: string }[]>([]);
  const [depositPct, setDepositPct] = useState("");
  const [depositOn, setDepositOn] = useState(false);
  const [minsLong, setMinsLong] = useState("");
  const [online, setOnline] = useState(false);
  const [staged, setStaged] = useState<StagedImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [billing, setBilling] = useState<JobBillingType>("lump_sum");
  const { config: fieldConfig } = useFieldConfig();
  const wsCur = workspaceCurrencyOf(fieldConfig);
  const categoryList = serviceCategoryList(fieldConfig);
  const configReady = fieldConfig !== null;
  const timeBased = fieldConfig?.timesheetsEnabled === true && billing === "time_and_materials";
  // A Time & materials service is never bookable online, whether or not timesheets are on right now.
  const timeService = billing === "time_and_materials";
  const estimateHours = ((Number.parseInt(hoursLong || "0", 10) || 0) * 60 + (Number.parseInt(minsLong || "0", 10) || 0)) / 60;
  const estimateText = `${currency} ${(estimateHours * (Number.parseFloat(rate || "0") || 0)).toFixed(2)}`;
  const [view, setView] = useState<"details" | "messages">("details");

  // Fill once per opening, so a live update to the product doesn't wipe typing.
  const serviceId = service?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setName(service?.name ?? "");
    setColor(service?.color ?? "");
    setCategory(serviceCategoryOf(categoryList, service?.category));
    setDescription(service?.description ?? "");
    setPrice(service ? String(service.unitPriceCents / 100) : "");
    setRate(service?.estimateRateCents ? String(service.estimateRateCents / 100) : "");
    setStaffNeeded(String(service?.staffRequired ?? 1));
    setCurrency(wsCur);
    const len = service?.durationMinutes ?? 0;
    setHoursLong(len >= 60 ? String(Math.floor(len / 60)) : "");
    setMinsLong(len % 60 ? String(len % 60) : "");
    setLeadHours(typeof service?.minLeadHours === "number" ? String(service.minLeadHours) : "");
    setTravelMins(typeof service?.travelMinutes === "number" ? String(service.travelMinutes) : "");
    setVariants(
      (service?.variants ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        mins: v.durationMinutes > 0 ? String(v.durationMinutes) : "",
        price: String(v.unitPriceCents / 100),
      })),
    );
    setDepositPct(typeof service?.depositPercent === "number" && service.depositPercent > 0 ? String(service.depositPercent) : "");
    // A new service starts with no deposit; an older one with no setting uses the workspace default.
    setDepositOn(service ? service.depositPercent !== 0 : false);
    setOnline(bookable);
    setStaged([]);
    setBilling(service?.billingType ?? "lump_sum");
    setView("details");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fill only when the dialog opens for a service
  }, [open, serviceId, configReady]);

  async function save() {
    let amount = Number.parseFloat(price || "0");
    if (!name.trim()) return;
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error("Enter a valid price.");
      return;
    }
    const length = (Number.parseInt(hoursLong || "0", 10) || 0) * 60 + (Number.parseInt(minsLong || "0", 10) || 0);
    if (length > 1440) {
      toast.error("A service can be at most 24 hours long.");
      return;
    }
    const rateNum = Number.parseFloat(rate || "0");
    if (timeBased) {
      if (length <= 0) {
        toast.error("Enter the estimated hours.");
        return;
      }
      if (!Number.isFinite(rateNum) || rateNum < 0) {
        toast.error("Enter a valid hourly rate.");
        return;
      }
      amount = (length / 60) * rateNum;
    }
    if (travelMins === "") {
      toast.error("Choose a travel time allowance.");
      return;
    }
    if (variants.some((v) => !v.name.trim() || !Number.isFinite(Number.parseFloat(v.price || "0")) || Number.parseFloat(v.price || "0") < 0)) {
      toast.error("Each option needs a name and a valid price.");
      return;
    }
    setBusy(true);
    try {
      const base = `/api/sub-accounts/${subAccountId}/products`;
      const body = {
        name,
        kind: "service",
        description,
        category,
        color,
        billingType: billing,
        unitPriceCents: Math.round(amount * 100),
        ...(timeBased ? { estimateRateCents: Math.round(rateNum * 100) } : billing === "lump_sum" ? { estimateRateCents: 0 } : {}),
        staffRequired: Number.parseInt(staffNeeded, 10) || 1,
        currency,
        durationMinutes: length > 0 ? length : service ? 0 : undefined,
        travelMinutes: Number.parseInt(travelMins, 10) || 0,
        variants: (timeBased ? [] : variants).map((v) => ({
          id: v.id,
          name: v.name.trim(),
          durationMinutes: Math.min(1440, Number.parseInt(v.mins || "0", 10) || 0),
          unitPriceCents: Math.round(Number.parseFloat(v.price || "0") * 100),
        })),
        ...(leadHours.trim() !== "" ? { minLeadHours: Number.parseInt(leadHours, 10) || 0 } : service ? { minLeadHours: null } : {}),
        depositPercent: !depositOn ? 0 : depositPct.trim() === "" ? null : Math.min(100, Number.parseInt(depositPct, 10) || 0),
      };
      const res = await fetch(service ? `${base}/${service.id}` : base, {
        method: service ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "That didn't save.");
        return;
      }
      const id = service?.id ?? data.id;
      if (!id) {
        toast.error("That didn't save.");
        return;
      }
      for (const img of staged) {
        try {
          await uploadProductImage(subAccountId, id, img.file);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "The photo didn't upload.");
          break;
        }
      }
      const wantOnline = timeService ? false : online;
      if (canChangeBookable && wantOnline !== bookable) await onBookable(id, wantOnline);
      toast.success(service ? "Service saved." : "Service added.");
      onOpenChange(false);
    } catch {
      toast.error("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="flex h-[85dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{service ? "Edit service" : "New service"}</DialogTitle>
          <DialogDescription>
            What you do on site. Services are part of your product catalog, so they can be picked when you build an
            estimate or invoice.
          </DialogDescription>
        </DialogHeader>

        {service && canChangeBookable && (
          <div className="inline-flex w-fit rounded-lg border p-0.5" role="group" aria-label="Section">
            {(
              [
                ["details", "Details"],
                ["messages", "Customer messages"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => setView(id)}
                className={
                  "rounded-md px-3 py-1.5 text-sm " +
                  (view === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {view === "messages" && service ? (
          <ServiceMessages subAccountId={subAccountId} productId={service.id} messages={service.customerMessages} />
        ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">Service name</Label>
              <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Drain clearing" />
            </div>
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">Category</Label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring [&_option]:bg-background [&_option]:text-foreground"
              >
                {categoryList.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={online && !timeService}
                disabled={!canChangeBookable || timeService}
                onCheckedChange={(v) => setOnline(v === true)}
              />
              <span>
                <span className="block font-medium">Bookable online</span>
                <span className="block text-xs text-muted-foreground">
                  {timeService
                    ? "Time and materials services are booked by your office, not online."
                    : canChangeBookable
                    ? "Customers can pick this service on your online booking page."
                    : "Only an admin can change this."}
                </span>
              </span>
            </label>
            {online && !timeService && (
              <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
                <div>
                  <Label className="mb-1 block text-xs font-medium text-muted-foreground">Minimum notice (hours)</Label>
                  <Input
                    value={leadHours}
                    inputMode="numeric"
                    onChange={(e) => setLeadHours(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    placeholder="2"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">The soonest it can be booked, such as 48 for two days. Empty uses 2.</p>
                </div>
                <div>
                  <label className="mb-1 flex cursor-pointer items-center gap-2 text-sm font-medium">
                    <Checkbox checked={depositOn} onCheckedChange={(v) => setDepositOn(v === true)} />
                    Take a deposit
                  </label>
                  {depositOn ? (
                    <>
                      <Input
                        value={depositPct}
                        inputMode="numeric"
                        aria-label="Deposit percent of the price"
                        onChange={(e) => setDepositPct(e.target.value.replace(/\D/g, "").slice(0, 3))}
                        placeholder="Workspace default"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">% of the price. Empty uses the Online booking tab default.</p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">Customers pay a deposit by card when they book.</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {service && canChangeBookable && !timeService ? <ServiceAddOnPicker serviceId={service.id} /> : null}

          <div className="space-y-3">
            <SectionHead>Pricing and time</SectionHead>
            {fieldConfig?.timesheetsEnabled === true && (
              <div className="sm:max-w-sm">
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Pricing basis</Label>
                <select
                  value={billing}
                  onChange={(e) => setBilling(e.target.value as JobBillingType)}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring [&_option]:bg-background [&_option]:text-foreground"
                >
                  {(["lump_sum", "time_and_materials"] as const).map((t) => (
                    <option key={t} value={t}>
                      {BILLING_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {billing === "lump_sum"
                    ? "The customer pays the price below. Hours are kept for your records only."
                    : "The customer pays for the hours logged on the project at each worker's rate, plus parts. The figures below only make the project's estimate."}
                </p>
              </div>
            )}
            {timeBased ? (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="mb-1 block text-xs font-medium text-muted-foreground">Estimated hours</Label>
                    <Input
                      value={hoursLong}
                      inputMode="numeric"
                      onChange={(e) => setHoursLong(e.target.value.replace(/\D/g, "").slice(0, 2))}
                      placeholder="3"
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs font-medium text-muted-foreground">Minutes</Label>
                    <Input
                      value={minsLong}
                      inputMode="numeric"
                      onChange={(e) => setMinsLong(e.target.value.replace(/\D/g, "").slice(0, 2))}
                      placeholder="30"
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs font-medium text-muted-foreground">Estimated rate per hour ({currency})</Label>
                    <Input value={rate} inputMode="decimal" onChange={(e) => setRate(e.target.value)} placeholder="150" />
                  </div>
                </div>
                <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
                  Estimate: <span className="font-semibold">{estimateText}</span>
                  <span className="block text-xs text-muted-foreground">
                    An internal estimate for the project, not a charge. The invoice is built from the hours logged on the project.
                    Not offered for online booking.
                  </span>
                </p>
              </>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="mb-1 block text-xs font-medium text-muted-foreground">Price ({currency})</Label>
                    <Input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} placeholder="129" />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs font-medium text-muted-foreground">Hours</Label>
                    <Input
                      value={hoursLong}
                      inputMode="numeric"
                      onChange={(e) => setHoursLong(e.target.value.replace(/\D/g, "").slice(0, 2))}
                      placeholder="1"
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs font-medium text-muted-foreground">Minutes</Label>
                    <Input
                      value={minsLong}
                      inputMode="numeric"
                      onChange={(e) => setMinsLong(e.target.value.replace(/\D/g, "").slice(0, 2))}
                      placeholder="30"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Hours and minutes are how long the job takes. Instant booking uses them to find a free stretch.</p>
              </>
            )}
            <div className="sm:max-w-xs">
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">Staff needed (required)</Label>
              <select
                value={staffNeeded}
                onChange={(e) => setStaffNeeded(e.target.value)}
                aria-required="true"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring [&_option]:bg-background [&_option]:text-foreground"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={String(n)}>
                    {n === 1 ? "1 person" : `${n} people`}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                How many staff are on site at once. Online booking only offers times when this many are free together, and holds all of them.
              </p>
            </div>
            <div className="sm:max-w-xs">
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">Travel time allowance (required)</Label>
              <select
                value={travelMins}
                onChange={(e) => setTravelMins(e.target.value)}
                aria-required="true"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring [&_option]:bg-background [&_option]:text-foreground"
              >
                <option value="">Choose…</option>
                {TRAVEL_CHOICES.map((m) => (
                  <option key={m} value={String(m)}>
                    {m === 0 ? "None" : travelLabel(m)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Kept free before and after each job, so two visits are never placed closer than this.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <SectionHead>Details</SectionHead>
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">Description</Label>
              <Textarea
                rows={3}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Full tune up and safety check for one system."
              />
              <p className="mt-1 text-xs text-muted-foreground">Customers see the start of this on the booking page.</p>
            </div>
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">Colour</Label>
              <div className="flex flex-wrap items-center gap-2">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Colour ${c}`}
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                    className={"h-6 w-6 rounded-full border-2 " + (color === c ? "border-foreground" : "border-transparent")}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <Button type="button" variant="ghost" size="sm" disabled={!color} onClick={() => setColor("")}>
                  No colour
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">A stripe on the booking card and on visits of this service in the Schedule.</p>
            </div>
          </div>

          <div className={"space-y-2 " + (timeBased ? "hidden" : "")}>
            <SectionHead>Options (optional)</SectionHead>
            <p className="text-xs text-muted-foreground">
              For a service that comes in kinds, such as Easy or Hard, each with its own time and price. The customer or the office
              picks one, and it replaces the time and price above for that job.
            </p>
            {variants.map((v, i) => (
              <div key={v.id || i} className="grid grid-cols-[1fr_5rem_6rem_auto] items-center gap-2">
                <Input
                  value={v.name}
                  maxLength={60}
                  placeholder="Easy access"
                  aria-label="Option name"
                  onChange={(e) => setVariants((cur) => cur.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))}
                />
                <Input
                  value={v.mins}
                  inputMode="numeric"
                  placeholder="Min"
                  aria-label="Minutes"
                  onChange={(e) => setVariants((cur) => cur.map((x, k) => (k === i ? { ...x, mins: e.target.value.replace(/\D/g, "").slice(0, 4) } : x)))}
                />
                <Input
                  value={v.price}
                  inputMode="decimal"
                  placeholder="Price"
                  aria-label="Price"
                  onChange={(e) => setVariants((cur) => cur.map((x, k) => (k === i ? { ...x, price: e.target.value } : x)))}
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => setVariants((cur) => cur.filter((_, k) => k !== i))}>
                  Remove
                </Button>
              </div>
            ))}
            {variants.length < 8 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setVariants((cur) => [...cur, { id: "", name: "", mins: "", price: price || "" }])}
              >
                Add option
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <SectionHead>Photos</SectionHead>
            {service ? (
              <ProductImagesField mode="live" subAccountId={subAccountId} productId={service.id} images={service.images ?? []} />
            ) : (
              <ProductImagesField mode="staged" staged={staged} onStagedChange={setStaged} />
            )}
          </div>
        </div>
        )}
        </div>

        <DialogFooter className="gap-2">
          {service && (
            <Button type="button" variant="outline" className="sm:mr-auto" onClick={() => onChecklist(service)}>
              Checklist
            </Button>
          )}
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {view === "details" && (
            <Button type="button" disabled={busy || !name.trim()} onClick={() => void save()}>
              {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              {service ? "Save" : "Add service"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
