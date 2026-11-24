"use client";

import { formatMinutes } from "@/lib/field-services/duration";
import { serviceCategoryList, serviceCategoryOf } from "@/lib/field-services/service-categories";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, MapPin, Plus, Trash2, Wrench } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import {
  subscribeToServiceAreas,
  subscribeToServices,
} from "@/lib/firestore/field-services";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChecklistTemplateDialog } from "@/components/field-services/checklist-template-dialog";
import { AddOnsSection } from "@/components/field-services/add-ons-section";
import { ServiceDialog } from "@/components/field-services/service-dialog";
import { ServiceAreasMap } from "@/components/field-services/service-areas-map";
import type { ChecklistTemplateView } from "@/lib/server/field-checklists-service";
import type { Product } from "@/types/products";
import type {
  FieldServicesConfig,
  OutOfAreaPolicy,
  ServiceArea,
} from "@/types/field-services";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground";

const COUNTRIES: { code: string; label: string }[] = [
  { code: "US", label: "United States (ZIP)" },
  { code: "CA", label: "Canada (postal code)" },
  { code: "GB", label: "United Kingdom (postcode)" },
  { code: "AU", label: "Australia (postcode)" },
  { code: "NZ", label: "New Zealand (postcode)" },
  { code: "IE", label: "Ireland (Eircode)" },
];

function defaultCountry(): string {
  try {
    const region = new Intl.Locale(navigator.language).region;
    if (region && COUNTRIES.some((c) => c.code === region)) return region;
  } catch {
  }
  return "US";
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

async function send(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: Record<string, unknown>,
): Promise<boolean> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return true;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  toast.error(data.error ?? "That didn't work.");
  return false;
}

export function ServicesAreasTab() {
  const { subAccountId, isAdmin } = useSubAccount();

  const [services, setServices] = useState<Product[]>([]);
  const [areas, setAreas] = useState<ServiceArea[]>([]);
  const [config, setConfig] = useState<FieldServicesConfig | null>(null);
  const categoryList = serviceCategoryList(config);

  // "new" while adding, otherwise the id of the service being edited.
  const [serviceEdit, setServiceEdit] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Record<string, ChecklistTemplateView>>({});
  const [editing, setEditing] = useState<Product | null>(null);

  const [areaName, setAreaName] = useState("");
  const [areaCountry, setAreaCountry] = useState("US");
  const [areaCodes, setAreaCodes] = useState("");
  const [areaFee, setAreaFee] = useState("");
  const [areaBusy, setAreaBusy] = useState(false);
  const [areaKind, setAreaKind] = useState<"zip" | "radius">("zip");
  const [areaCenter, setAreaCenter] = useState("");
  const [areaRadius, setAreaRadius] = useState("");
  const [areaUnit, setAreaUnit] = useState<"km" | "mi">("km");
  const radiusAvailable = Boolean(process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim());

  const base = `/api/sub-accounts/${subAccountId}`;

  useEffect(() => {
    setAreaCountry(defaultCountry());
  }, []);

  useEffect(() => subscribeToServices(subAccountId, setServices), [subAccountId]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetch(`${base}/field-services/checklists`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { templates?: ChecklistTemplateView[] } | null) => {
        if (!cancelled && d?.templates) setTemplates(Object.fromEntries(d.templates.map((t) => [t.productId, t])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [base, isAdmin]);
  useEffect(() => subscribeToServiceAreas(subAccountId, setAreas), [subAccountId]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${base}/field-services/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { config?: FieldServicesConfig } | null) => {
        if (!cancelled && d?.config) setConfig(d.config);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [base]);

  const bookableIds = config?.bookingServiceIds ?? [];
  async function setBookable(id: string, on: boolean): Promise<boolean> {
    const next = on ? [...new Set([...bookableIds, id])] : bookableIds.filter((x) => x !== id);
    const ok = await send(`${base}/field-services/config`, "PATCH", { bookingServiceIds: next });
    if (ok) {
      // The server may have dropped an id (a Time & materials service), so show what it kept.
      try {
        const res = await fetch(`${base}/field-services/config`);
        const d = (res.ok ? await res.json() : null) as { config?: FieldServicesConfig } | null;
        if (d?.config) setConfig(d.config);
        else setConfig((c) => (c ? { ...c, bookingServiceIds: next } : c));
      } catch {
        setConfig((c) => (c ? { ...c, bookingServiceIds: next } : c));
      }
    }
    return ok;
  }

  async function addArea() {
    setAreaBusy(true);
    const fee = areaFee ? Math.round(Number.parseFloat(areaFee) * 100) : null;
    const travelFeeCents = fee !== null && Number.isFinite(fee) ? fee : null;
    const ok = await send(
      `${base}/field-services/service-areas`,
      "POST",
      areaKind === "radius"
        ? {
            type: "radius",
            name: areaName,
            country: areaCountry,
            centerAddress: areaCenter,
            radius: Number.parseFloat(areaRadius),
            radiusUnit: areaUnit,
            travelFeeCents,
          }
        : { name: areaName, country: areaCountry, postcodes: areaCodes, travelFeeCents },
    );
    setAreaBusy(false);
    if (ok) {
      setAreaName("");
      setAreaCodes("");
      setAreaFee("");
      setAreaCenter("");
      setAreaRadius("");
    }
  }

  async function setPolicy(policy: OutOfAreaPolicy) {
    if (await send(`${base}/field-services/config`, "PATCH", { outOfAreaPolicy: policy })) {
      setConfig((c) => (c ? { ...c, outOfAreaPolicy: policy } : c));
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border bg-card p-6">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Wrench className="h-4 w-4" /> Services
          </h2>
          <Button size="sm" onClick={() => setServiceEdit("new")}>
            <Plus className="mr-1 h-3.5 w-3.5" /> New service
          </Button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          What you do on site. Services are part of your product catalog, so
          they can be picked when you build an estimate or invoice.
        </p>

        {services.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No services yet.</p>
        ) : (
          <ul className="mt-4 divide-y rounded-lg border">
            {services.map((s) => (
              <li key={s.id} className="flex items-center gap-3 p-3">
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-full bg-muted-foreground/30"
                  style={s.color ? { backgroundColor: s.color } : undefined}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {s.name}
                    {bookableIds.includes(s.id) && (
                      <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                        Online
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {`${serviceCategoryOf(categoryList, s.category)} · `}
                    {money(s.unitPriceCents, s.currency)}
                    {s.durationMinutes ? ` · ${formatMinutes(s.durationMinutes)}` : ""}
                    {templates[s.id]
                      ? ` · Checklist${templates[s.id].items.length ? ` (${templates[s.id].items.length})` : ""}${templates[s.id].requireSignature ? ", signature" : ""}`
                      : ""}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setServiceEdit(s.id)}>
                  Edit
                </Button>
                {isAdmin && (
                  <Button variant="outline" size="sm" onClick={() => setEditing(s)}>
                    Checklist
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Archive ${s.name}`}
                  onClick={() => void send(`${base}/products/${s.id}`, "DELETE")}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

      </section>

      {isAdmin && <AddOnsSection services={services.map((sv) => ({ id: sv.id, name: sv.name }))} />}

      <ServiceDialog
        open={serviceEdit !== null}
        onOpenChange={(o) => !o && setServiceEdit(null)}
        subAccountId={subAccountId}
        service={serviceEdit && serviceEdit !== "new" ? (services.find((x) => x.id === serviceEdit) ?? null) : null}
        bookable={serviceEdit !== null && serviceEdit !== "new" && bookableIds.includes(serviceEdit)}
        canChangeBookable={isAdmin}
        onBookable={setBookable}
        onChecklist={(svc) => {
          setServiceEdit(null);
          setEditing(svc);
        }}
      />

      <ChecklistTemplateDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        base={base}
        service={editing ? { id: editing.id, name: editing.name } : null}
        template={editing ? (templates[editing.id] ?? null) : null}
        onSaved={(productId, t) =>
          setTemplates((all) => {
            const next = { ...all };
            if (t) next[productId] = t;
            else delete next[productId];
            return next;
          })
        }
      />

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <MapPin className="h-4 w-4" /> Service areas
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Where you work, by postcode or by distance from a point. A request outside every
          area is flagged (or refused, if you choose below). UK outward codes such as SW1A and
          Canadian prefixes such as M5V cover the whole district.
        </p>

        {areas.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No areas yet, so requests are never checked against an area.
          </p>
        ) : (
          <ul className="mt-4 divide-y rounded-lg border">
            {areas.map((a) => (
              <li key={a.id} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.type === "radius"
                      ? `Within ${a.radiusUnit === "mi" ? Math.round(((a.radiusKm ?? 0) / 1.609344) * 100) / 100 : a.radiusKm} ${a.radiusUnit === "mi" ? "mi" : "km"} of ${a.center?.label ?? "a point"}`
                      : `${a.postcodes.length} code${a.postcodes.length === 1 ? "" : "s"}: ${a.postcodes.slice(0, 8).join(", ")}${a.postcodes.length > 8 ? "…" : ""}`}
                    {a.travelFeeCents ? ` · travel fee ${(a.travelFeeCents / 100).toFixed(2)}` : ""}
                  </p>
                </div>
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${a.name}`}
                    onClick={() =>
                      void send(`${base}/field-services/service-areas/${a.id}`, "DELETE")
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <ServiceAreasMap areas={areas} />

        {isAdmin && (
          <div className="mt-5 inline-flex rounded-lg border p-0.5" role="group" aria-label="Kind of area">
            {(
              [
                ["zip", "Postcodes"],
                ["radius", "Radius from a point"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={areaKind === id}
                onClick={() => setAreaKind(id)}
                className={
                  "rounded-md px-3 py-1.5 text-sm " +
                  (areaKind === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {isAdmin && (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Area name
              </Label>
              <Input
                value={areaName}
                onChange={(e) => setAreaName(e.target.value)}
                placeholder="Inner city"
                disabled={areaBusy}
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Country
              </Label>
              <select
                value={areaCountry}
                onChange={(e) => setAreaCountry(e.target.value)}
                disabled={areaBusy}
                className={SELECT_CLASS}
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Travel fee (optional, added only when you choose)
              </Label>
              <Input
                value={areaFee}
                onChange={(e) => setAreaFee(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                disabled={areaBusy}
              />
            </div>
            {areaKind === "zip" ? (
              <div className="sm:col-span-3">
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Postcodes (separate with commas, spaces or new lines)
                </Label>
                <Textarea
                  value={areaCodes}
                  onChange={(e) => setAreaCodes(e.target.value)}
                  rows={3}
                  disabled={areaBusy}
                />
              </div>
            ) : radiusAvailable ? (
              <>
                <div className="sm:col-span-2">
                  <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Measured from this address
                  </Label>
                  <Input
                    value={areaCenter}
                    onChange={(e) => setAreaCenter(e.target.value)}
                    placeholder="Your depot, shop or town"
                    disabled={areaBusy}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="mb-1 block text-xs font-medium text-muted-foreground">Radius</Label>
                    <Input
                      value={areaRadius}
                      onChange={(e) => setAreaRadius(e.target.value.replace(/[^\d.]/g, ""))}
                      inputMode="decimal"
                      placeholder="25"
                      disabled={areaBusy}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs font-medium text-muted-foreground">Unit</Label>
                    <select
                      value={areaUnit}
                      onChange={(e) => setAreaUnit(e.target.value as "km" | "mi")}
                      disabled={areaBusy}
                      className={SELECT_CLASS}
                    >
                      <option value="km">km</option>
                      <option value="mi">miles</option>
                    </select>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground sm:col-span-3">
                Radius areas need a Mapbox token on this deployment (NEXT_PUBLIC_MAPBOX_TOKEN). Use postcodes until it is set.
              </p>
            )}
            <div className="sm:col-span-3">
              <Button
                onClick={addArea}
                disabled={
                  areaBusy ||
                  !areaName.trim() ||
                  (areaKind === "zip"
                    ? !areaCodes.trim()
                    : !radiusAvailable || !areaCenter.trim() || !(Number.parseFloat(areaRadius) > 0))
                }
              >
                {areaBusy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Add area
              </Button>
            </div>
          </div>
        )}

        {isAdmin && config && (
          <div className="mt-6 border-t pt-4">
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              When a request is outside every area
            </Label>
            <select
              value={config.outOfAreaPolicy}
              onChange={(e) => void setPolicy(e.target.value as OutOfAreaPolicy)}
              className={SELECT_CLASS + " sm:max-w-xs"}
            >
              <option value="flag">Accept it and flag it for the team</option>
              <option value="block">Refuse it</option>
            </select>
          </div>
        )}
      </section>
    </div>
  );
}
