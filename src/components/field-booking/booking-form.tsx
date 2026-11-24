"use client";

import { formatMinutes } from "@/lib/field-services/duration";
import { DEFAULT_SERVICE_CATEGORY } from "@/lib/field-services/service-categories";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, CheckCircle2, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatMoneyCode } from "@/lib/field-services/money";
import { cn } from "@/lib/utils";
import { PublicCard } from "@/components/field-booking/public-frame";
import { Field, FieldArea, FieldSelect } from "@/components/field-booking/public-fields";
import { AddressSearch } from "@/components/address/address-search";
import type { AreaAnswer, PublicBookingConfig } from "@/lib/server/field-booking-service";

const WINDOWS: [string, string][] = [
  ["any", "Any time"],
  ["morning", "Morning"],
  ["afternoon", "Afternoon"],
  ["evening", "Evening"],
];

const COUNTRIES: [string, string][] = [
  ["AU", "Australia"],
  ["US", "United States"],
  ["GB", "United Kingdom"],
  ["CA", "Canada"],
  ["NZ", "New Zealand"],
  ["IE", "Ireland"],
  ["ZA", "South Africa"],
  ["SG", "Singapore"],
  ["AE", "United Arab Emirates"],
  ["IN", "India"],
  ["PH", "Philippines"],
  ["MY", "Malaysia"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["ES", "Spain"],
  ["IT", "Italy"],
  ["NL", "Netherlands"],
  ["SE", "Sweden"],
  ["NO", "Norway"],
  ["DK", "Denmark"],
  ["PT", "Portugal"],
  ["PL", "Poland"],
  ["JP", "Japan"],
  ["BR", "Brazil"],
  ["MX", "Mexico"],
];

const STEPS = ["Address", "Services", "When", "Your details"] as const;

type BookingService = PublicBookingConfig["services"][number];

/** A dropdown of services: the name with the description in small text under it. Replaces cards when only one can be chosen. */
function ServiceDropdown({
  groups,
  value,
  onChange,
}: {
  groups: [string, BookingService[]][];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const flat = useMemo(() => groups.flatMap(([, list]) => list), [groups]);
  const selected = flat.find((sv) => sv.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setActive(Math.max(0, flat.findIndex((sv) => sv.id === value)));
        setOpen(true);
        return;
      }
      setActive((i) => (e.key === "ArrowDown" ? Math.min(flat.length - 1, i + 1) : Math.max(0, i - 1)));
    } else if ((e.key === "Enter" || e.key === " ") && open) {
      e.preventDefault();
      if (flat[active]) pick(flat[active].id);
    }
  };

  const row = (sv: BookingService) => (
    <span className="flex w-full items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-base font-medium">{sv.name}</span>
        {sv.description && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{sv.description}</span>}
      </span>
      {(sv.variants.length > 0 ? Math.min(...sv.variants.map((v) => v.priceMinor)) : sv.priceMinor) > 0 && (
        <span className="shrink-0 text-sm tabular-nums">
          {sv.variants.length > 0 ? "From " : ""}
          {formatMoneyCode(sv.currency, sv.variants.length > 0 ? Math.min(...sv.variants.map((v) => v.priceMinor)) : sv.priceMinor)}
        </span>
      )}
    </span>
  );

  return (
    <div ref={root} className="relative" onKeyDown={onKey}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setActive(Math.max(0, flat.findIndex((sv) => sv.id === value)));
          setOpen((o) => !o);
        }}
        className="flex min-h-14 w-full items-center gap-3 rounded-xl border bg-background p-3 text-left hover:bg-muted/40"
      >
        <span className="min-w-0 flex-1">
          {selected ? row(selected) : <span className="text-base text-muted-foreground">Choose a service</span>}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-xl border bg-card p-1 shadow-lg"
        >
          {groups.map(([category, list]) => (
            <li key={category || "none"} role="presentation">
              {category && category !== DEFAULT_SERVICE_CATEGORY && <p className="px-3 pb-1 pt-2 text-xs font-semibold text-muted-foreground">{category}</p>}
              <ul role="presentation">
                {list.map((sv) => {
                  const index = flat.findIndex((x) => x.id === sv.id);
                  return (
                    <li key={sv.id} role="option" aria-selected={sv.id === value}>
                      <button
                        type="button"
                        tabIndex={-1}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => pick(sv.id)}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left",
                          index === active ? "bg-muted" : "",
                          sv.id === value && "ring-1 ring-primary",
                        )}
                      >
                        {row(sv)}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Done {
  number: string;
  statusUrl: string | null;
  scheduledLabel: string | null;
  depositToken: string | null;
  depositMinor: number;
  full: boolean;
}

type PayChoice = "deposit" | "full" | "in_person";

interface PriceQuote {
  currency: string;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
  tax: { name: string; percent: number; inclusive: boolean } | null;
  depositMinor: number;
  options: { deposit: boolean; full: boolean; inPerson: boolean };
}

interface Slot {
  start: string;
  time: string;
  label: string;
}

async function post<T>(url: string, body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? "Something went wrong. Please try again." };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "No connection. Check your signal and try again." };
  }
}

const dayKey = (d: Date) => d.toLocaleDateString("en-CA");

/** Quick picks for the date: tomorrow, the coming Saturday and next Monday. */
function quickDates(): [string, string][] {
  const now = new Date();
  const add = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  const toSat = now.getDay() === 6 ? 1 : (6 - now.getDay() + 7) % 7 || 7;
  const toMon = (1 - now.getDay() + 7) % 7 || 7;
  const all: [string, string][] = [
    ["Tomorrow", dayKey(add(1))],
    ["This weekend", dayKey(add(toSat))],
    ["Next week", dayKey(add(toMon))],
  ];
  // On a Friday the weekend starts tomorrow, and on a Sunday next week does, so those chips would repeat a date.
  return all.filter(([, value], i) => all.findIndex(([, v]) => v === value) === i);
}

export function FieldBookingForm({ subAccountId, config }: { subAccountId: string; config: PublicBookingConfig }) {
  const api = `/api/field-booking/${subAccountId}`;
  const openedAt = useRef(Date.now());
  // Sent with the request so a retry after a lost reply is not a second request.
  const [clientId] = useState(() =>
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 24) : String(Date.now()),
  );
  const only = config.services.length === 1 ? config.services[0] : null;
  const steps = STEPS.filter((st) => (st !== "Services" || !only) && (st !== "When" || config.askWhen || config.instant));
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);

  const [line1, setLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postcode, setPostcode] = useState("");
  const [country, setCountry] = useState(config.defaultCountry);
  const [area, setArea] = useState<AreaAnswer | null>(null);
  const [picked, setPicked] = useState<string[]>(() => (config.services.length === 1 ? [config.services[0].id] : []));
  const [variantPick, setVariantPick] = useState<Record<string, string>>({});
  const [addOnPick, setAddOnPick] = useState<string[]>([]);
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [payChoice, setPayChoice] = useState<PayChoice | "">("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [slotsBusy, setSlotsBusy] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  const [slotZone, setSlotZone] = useState("");
  const [timeOfDay, setTimeOfDay] = useState("any");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [consent, setConsent] = useState(true);
  const [hp, setHp] = useState("");

  const label = steps[step];
  const today = useMemo(() => dayKey(new Date()), []);
  const lastDay = useMemo(() => {
    const d = new Date();
    return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + config.maxDaysAhead));
  }, [config.maxDaysAhead]);
  const quick = useMemo(quickDates, []);
  const notice = config.services.find((sv) => sv.id === picked[0])?.minLeadHours ?? 0;
  // The earliest day a time could be offered. The server decides; this just keeps the picker honest.
  const earliest = config.instant && notice > 0 ? dayKey(new Date(Date.now() + notice * 3_600_000)) : today;
  const firstDay = earliest > today ? earliest : today;
  const formRef = useRef<HTMLDivElement>(null);
  // A service with options is priced and timed by the option picked.
  const chosen = config.services
    .filter((s) => picked.includes(s.id))
    .map((s) => {
      const v = s.variants.find((x) => x.id === variantPick[s.id]);
      return v
        ? {
            ...s,
            name: `${s.name} (${v.name})`,
            priceMinor: v.priceMinor,
            depositMinor: v.depositMinor ?? 0,
            durationMinutes: v.durationMinutes > 0 ? v.durationMinutes : s.durationMinutes,
          }
        : s;
    });
  const groups = useMemo(() => {
    const by = new Map<string, typeof config.services>();
    for (const sv of config.services) by.set(sv.category, [...(by.get(sv.category) ?? []), sv]);
    // The Default category comes first and has no heading, then each category in the order it first appears.
    const first = (c: string) => c === "" || c === DEFAULT_SERVICE_CATEGORY;
    return [...by.entries()].sort((a, b) => (first(a[0]) ? -1 : first(b[0]) ? 1 : 0));
  }, [config]);
  const priced = chosen.length > 0 && chosen.every((s) => s.priceMinor > 0);
  const total = chosen.reduce((sum, s) => sum + s.priceMinor, 0);
  const depositTotal = chosen.reduce((sum, s) => sum + s.depositMinor, 0);
  // Extras that go with the services picked. A tick on one that no longer applies is ignored.
  const availableAddOns = config.addOns.filter((a) => a.allServices || a.serviceIds.some((id) => picked.includes(id)));
  const addOnIds = addOnPick.filter((id) => availableAddOns.some((a) => a.id === id));
  const addOnKey = addOnIds.join(",");
  const variantsDone = config.services.every((sv) => !picked.includes(sv.id) || sv.variants.length === 0 || !!variantPick[sv.id]);
  const offeredPay: PayChoice[] = quote
    ? [
        ...(quote.options.deposit ? (["deposit"] as const) : []),
        ...(quote.options.full ? (["full"] as const) : []),
        ...(quote.options.inPerson ? (["in_person"] as const) : []),
      ]
    : [];
  const pay: PayChoice | "" = payChoice && offeredPay.includes(payChoice) ? payChoice : offeredPay.length === 1 ? offeredPay[0] : "";
  const payNow = !quote ? depositTotal : pay === "full" ? quote.totalMinor : pay === "deposit" ? quote.depositMinor : 0;
  const money = (minor: number) => formatMoneyCode(quote?.currency ?? chosen[0]?.currency ?? "USD", minor);
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState("");
  useEffect(() => {
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) setPayBusy(false);
    };
    window.addEventListener("pageshow", back);
    return () => window.removeEventListener("pageshow", back);
  }, []);
  const countries = COUNTRIES.some(([c]) => c === country) ? COUNTRIES : [[country, country] as [string, string], ...COUNTRIES];

  // A new step starts at the top with its heading read out, so keyboard and screen reader users aren't left behind.
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(0);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    window.scrollTo({ top: 0, behavior: "smooth" });
    heading.current?.focus();
  }, [step]);

  // The server works out what is charged, so the page only shows its answer.
  const pickedKey = picked.join(",");
  const variantKey = JSON.stringify(variantPick);
  useEffect(() => {
    setQuoteFailed(false);
    // The old figures must not drive the button or the pay choice while a new total is worked out.
    setQuote(null);
    if (!pickedKey || !variantsDone) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    void post<PriceQuote>(`${api}/quote`, {
      services: pickedKey.split(","),
      variants: Object.fromEntries(pickedKey.split(",").filter((id) => variantPick[id]).map((id) => [id, variantPick[id]])),
      addOnIds: addOnKey ? addOnKey.split(",") : [],
    }).then((res) => {
      if (cancelled) return;
      setQuote(res.ok ? res.data : null);
      setQuoteFailed(!res.ok);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the joined values above
  }, [api, pickedKey, variantKey, addOnKey, variantsDone]);

  const pickedId = picked[0] ?? "";
  useEffect(() => {
    if (!config.instant || label !== "When" || !date || !pickedId) return;
    let cancelled = false;
    setSlotsBusy(true);
    setSlotsError("");
    setSlot(null);
    void post<{ slots: Slot[]; timezone: string }>(`${api}/slots`, {
      serviceId: pickedId,
      variantId: variantPick[pickedId] ?? "",
      addOnIds: addOnKey ? addOnKey.split(",") : [],
      date,
      line1,
      city,
      region: state,
      postcode,
      country,
    }).then((res) => {
      if (cancelled) return;
      setSlotsBusy(false);
      if (!res.ok) {
        setSlots([]);
        setSlotsError(res.error);
        return;
      }
      setSlots(res.data.slots);
      setSlotZone(res.data.timezone);
    });
    return () => {
      cancelled = true;
    };
  }, [config.instant, label, date, pickedId, variantPick, addOnKey, api, line1, city, state, postcode, country]);

  async function next() {
    setError("");
    if (label === "Address") {
      if (!line1.trim() || !postcode.trim()) {
        setError("Enter the street address and postcode.");
        return;
      }
      setBusy(true);
      const res = await post<AreaAnswer>(`${api}/area`, { country, postcode, line1, city, region: state });
      setBusy(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setArea(res.data);
      if (res.data.blocked) return;
    }
    if (label === "Services" && picked.length === 0) {
      setError("Choose at least one service.");
      return;
    }
    if (label === "Services" && config.services.some((sv) => picked.includes(sv.id) && sv.variants.length > 0 && !variantPick[sv.id])) {
      setError("Choose an option for each service.");
      return;
    }
    if (label === "When" && only && only.variants.length > 0 && !variantPick[only.id]) {
      setError(`Choose an option for ${only.name}.`);
      return;
    }
    if (label === "When" && date && date < today) {
      setError("Choose a date from today onwards.");
      return;
    }
    if (label === "When" && config.instant && !slot) {
      setError("Choose a day and a time.");
      return;
    }
    setStep((s) => s + 1);
  }

  async function payDeposit(token: string) {
    setPayBusy(true);
    setPayError("");
    const res = await post<{ url: string }>(`/api/quotes/${token}/pay`, {});
    if (!res.ok) {
      setPayBusy(false);
      setPayError(res.error);
      return;
    }
    window.location.assign(res.data.url);
  }

  async function submit() {
    setError("");
    if (!name.trim() || !email.trim()) {
      setError("Enter your name and email.");
      return;
    }
    if (!quote && quoteFailed) {
      setError("We couldn't work out your total. Check your choices or try again in a moment.");
      return;
    }
    if (offeredPay.length > 1 && !pay) {
      setError("Choose how you would like to pay.");
      return;
    }
    setBusy(true);
    const res = await post<{ number: string; statusUrl: string | null; scheduledLabel: string | null; depositToken: string | null; depositMinor: number }>(`${api}/submit`, {
      services: picked,
      addOnIds,
      ...(pay ? { payChoice: pay } : {}),
      variants: Object.fromEntries(picked.filter((id) => variantPick[id]).map((id) => [id, variantPick[id]])),
      address: { line1, city, state, postcode, country },
      ...(config.askWhen && !config.instant && date ? { date, window: timeOfDay } : {}),
      ...(config.instant ? { slot: slot?.start ?? "" } : {}),
      name,
      email,
      phone,
      notes,
      consent,
      clientId,
      hp,
      elapsedMs: Date.now() - openedAt.current,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      if (config.instant && /just taken/i.test(res.error)) {
        setSlot(null);
        setSlots(null);
        setStep((steps as readonly string[]).indexOf("When"));
      }
      return;
    }
    setDone({
      number: res.data.number,
      statusUrl: res.data.statusUrl,
      scheduledLabel: res.data.scheduledLabel ?? null,
      depositToken: res.data.depositToken ?? null,
      depositMinor: res.data.depositMinor ?? 0,
      full: pay === "full",
    });
    if (res.data.depositToken) void payDeposit(res.data.depositToken);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (done) {
    return (
      <div className="mx-auto w-full max-w-lg space-y-6">
        <PublicCard className="ls-step text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-primary" />
          <h1 className="mt-3 text-xl font-semibold">
            {done.depositToken ? (done.full ? "Complete your payment" : "Pay your deposit") : done.scheduledLabel ? "You're booked" : "Request sent"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Thanks, {name.split(/\s+/)[0]}.{done.number ? ` Your reference is ${done.number}.` : ""}
          </p>
          {done.depositToken && (
            <div className="mt-4 space-y-3 rounded-xl bg-muted/50 p-4 text-left text-sm">
              <p>
                {done.scheduledLabel ? `We are holding ${done.scheduledLabel} for you for 30 minutes. ` : ""}
                Pay {done.full ? "" : "the deposit of "}{money(done.depositMinor)} by card to confirm your booking.
              </p>
              {payError && (
                <p role="alert" className="text-destructive">
                  {payError}
                </p>
              )}
              <Button className="h-12 w-full text-base" disabled={payBusy} onClick={() => void payDeposit(done.depositToken as string)}>
                {payBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {done.full ? "Pay now" : "Pay deposit"}
              </Button>
            </div>
          )}
          {config.doneMessage && <p className="mt-3 text-sm">{config.doneMessage}</p>}

          <ol className="mt-6 space-y-3 text-left">
            {[
              ["We have your request", "A confirmation is on its way to you."],
              done.scheduledLabel
                ? ["Your time is booked", `${done.scheduledLabel}. We'll send a reminder.`]
                : ["We confirm a time", `${config.businessName} will contact you to agree when to visit.`],
              ["We visit", "You'll get a reminder, and you can follow progress any time."],
            ].map(([title, text], i) => (
              <li key={title} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  {i + 1}
                </span>
                <span className="text-sm">
                  <span className="block font-medium">{title}</span>
                  <span className="text-muted-foreground">{text}</span>
                </span>
              </li>
            ))}
          </ol>

          <div className="mt-6 flex flex-col gap-2">
            {done.statusUrl && (
              <Button className="h-12 text-base" render={<a href={done.statusUrl} />}>
                Track your request
              </Button>
            )}
            {config.portalOpen && (
              <Button variant="outline" className="h-12 text-base" render={<a href={`/customer/${subAccountId}`} />}>
                See all your requests
              </Button>
            )}
          </div>
        </PublicCard>
      </div>
    );
  }

  const last = step === steps.length - 1;

  const toForm = (serviceId?: string) => {
    if (serviceId) setPicked([serviceId]);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => heading.current?.focus({ preventScroll: true }), 400);
  };

  const areaNote = (
    <>
    {area?.status === "in_area" && (
      <p className="flex items-start gap-2 rounded-lg bg-primary/10 p-3 text-sm">
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          Good news, we cover your area.
          {area.travelFeeMinor
            ? ` A travel fee of ${formatMoneyCode(config.services[0]?.currency ?? "USD", area.travelFeeMinor)} may apply.`
            : ""}
        </span>
      </p>
    )}
    {area?.status === "out_of_area" && (
      <p className="rounded-lg bg-[var(--ls-warn-bg)] p-3 text-sm text-[var(--ls-warn)]">
        That address is outside our usual area. You can still send a request and we&apos;ll check if we can help.
      </p>
    )}
    </>
  );

  /** The option picker for a service that has options. */
  function addOnFields() {
    if (availableAddOns.length === 0) return null;
    return (
      <fieldset className="space-y-2 rounded-xl border p-4">
        <legend className="px-1 text-sm font-medium">Add extras (optional)</legend>
        {availableAddOns.map((a) => (
          <label key={a.id} className="flex cursor-pointer items-center gap-3 text-sm">
            <Checkbox
              checked={addOnIds.includes(a.id)}
              onCheckedChange={(v) => {
                setSlot(null);
                setAddOnPick((cur) => (v === true ? [...cur.filter((x) => x !== a.id), a.id] : cur.filter((x) => x !== a.id)));
              }}
            />
            <span className="flex-1">
              {a.name}
              {a.extraMinutes > 0 ? <span className="text-muted-foreground"> · +{formatMinutes(a.extraMinutes)}</span> : null}
            </span>
            {a.priceMinor > 0 && <span className="tabular-nums">{formatMoneyCode(chosen[0]?.currency ?? "USD", a.priceMinor)}</span>}
          </label>
        ))}
      </fieldset>
    );
  }

  function variantFields(s: (typeof config.services)[number]) {
    return (
      <fieldset key={s.id} className="space-y-2 rounded-xl border p-4">
        <legend className="px-1 text-sm font-medium">Choose an option for {s.name}</legend>
        {s.variants.map((v) => (
          <label key={v.id} className="flex cursor-pointer items-center gap-3 text-sm">
            <input
              type="radio"
              name={`variant-${s.id}`}
              checked={variantPick[s.id] === v.id}
              onChange={() => {
                setSlot(null);
                setSlots(null);
                setVariantPick((p) => ({ ...p, [s.id]: v.id }));
              }}
            />
            <span className="flex-1">
              {v.name}
              {v.durationMinutes > 0 ? ` · about ${formatMinutes(v.durationMinutes)}` : ""}
            </span>
            {v.priceMinor > 0 && <span className="tabular-nums">{formatMoneyCode(s.currency, v.priceMinor)}</span>}
          </label>
        ))}
      </fieldset>
    );
  }

  return (
    <div className="space-y-10">
      <div className="grid gap-8 lg:grid-cols-[1fr_28rem] lg:items-start">
      <section className="py-2 text-center sm:py-6 lg:py-4 lg:text-left">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{only ? `Book ${only.name}` : "Book a service"}</h1>
        <p className="mx-auto mt-3 max-w-xl text-base text-muted-foreground lg:mx-0">
          {config.intro ||
            (only
              ? "Tell us where you are and when suits you, and we will confirm a time."
              : "Tell us where you are, choose what you need and when suits you, and we will confirm a time.")}
        </p>
        {only && (
          <div
            className="mx-auto mt-5 max-w-lg rounded-2xl border bg-card p-4 text-left shadow-sm lg:mx-0"
            style={only.color ? { borderLeftColor: only.color, borderLeftWidth: 4 } : undefined}
          >
            <div className="flex items-start gap-3">
              {only.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- storage URL of the service photo
                <img src={only.imageUrl} alt="" referrerPolicy="no-referrer" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-base font-semibold">{only.name}</p>
                {only.description && <p className="mt-0.5 text-sm text-muted-foreground">{only.description}</p>}
                {only.durationMinutes && <p className="mt-1 text-xs text-muted-foreground">About {formatMinutes(only.durationMinutes)}</p>}
              </div>
              {only.priceMinor > 0 && (
                <div className="shrink-0 text-right">
                  <p className="text-lg font-semibold tabular-nums">{formatMoneyCode(only.currency, only.priceMinor)}</p>
                  {only.depositMinor > 0 && (
                    <p className="text-xs text-muted-foreground">{formatMoneyCode(only.currency, only.depositMinor)} deposit to book</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <div ref={formRef} id="book" className="mx-auto w-full max-w-lg scroll-mt-6 lg:mx-0">
      <PublicCard className="p-0 sm:p-0">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            if (last) void submit();
            else void next();
          }}
        >
          <div className="p-5 pb-4 sm:p-7 sm:pb-5">
            <div
              role="progressbar"
              aria-valuemin={1}
              aria-valuemax={steps.length}
              aria-valuenow={step + 1}
              aria-label={`Step ${step + 1} of ${steps.length}`}
              className="flex gap-1.5"
            >
              {steps.map((s, i) => (
                <span key={s} className={cn("h-1.5 flex-1 rounded-full transition-colors", i <= step ? "bg-primary" : "bg-muted")} />
              ))}
            </div>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Step {step + 1} of {steps.length}
            </p>
            <h2 ref={heading} tabIndex={-1} className="mt-0.5 text-lg font-semibold outline-none">
              {label}
            </h2>

            <div key={label} className="ls-step mt-4 space-y-4">
              {/* Bots fill this; people never see it. */}
              <input
                type="text"
                tabIndex={-1}
                name="bp_ref_code"
                // Browsers ignore "off" and fill hidden fields, which makes a real request look like a bot.
                autoComplete="nope"
                aria-hidden="true"
                value={hp}
                onChange={(e) => setHp(e.target.value)}
                className="absolute -left-[9999px] h-0 w-0 opacity-0"
              />

              {only && step === 1 && areaNote}

              {label === "Address" && (
                <>
                  <AddressSearch
                    large
                    country={country}
                    onPick={(a) => {
                      setLine1(a.line1);
                      setCity(a.city);
                      setState(a.region);
                      setPostcode(a.postcode);
                      setCountry(a.country);
                      setArea(null);
                    }}
                  />
                  <Field
                    label="Street address"
                    value={line1}
                    maxLength={200}
                    autoComplete="address-line1"
                    onChange={(e) => {
                      setLine1(e.target.value);
                      setArea(null);
                    }}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="City / suburb" value={city} maxLength={100} autoComplete="address-level2" onChange={(e) => setCity(e.target.value)} />
                    <Field label="State" value={state} maxLength={100} autoComplete="address-level1" onChange={(e) => setState(e.target.value)} />
                    <Field
                      label="Postcode"
                      value={postcode}
                      maxLength={12}
                      autoComplete="postal-code"
                      onChange={(e) => {
                        setPostcode(e.target.value);
                        setArea(null);
                      }}
                    />
                    <FieldSelect
                      label="Country"
                      value={country}
                      options={countries}
                      autoComplete="country"
                      onChange={(e) => {
                        setCountry(e.target.value);
                        setArea(null);
                      }}
                    />
                  </div>
                  {area?.blocked && (
                    <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                      Sorry, that address is outside the areas we serve.
                    </p>
                  )}
                </>
              )}

              {label === "Services" && (
                <>
                  {areaNote}
                  {config.singleService ? (
                    <ServiceDropdown
                      groups={groups}
                      value={picked[0] ?? ""}
                      onChange={(id) => {
                        setSlot(null);
                        setSlots(null);
                        setPicked([id]);
                      }}
                    />
                  ) : (
                  groups.map(([category, list]) => (
                  <div key={category || "none"}>
                  {category && category !== DEFAULT_SERVICE_CATEGORY && <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{category}</h3>}
                  <ul className="space-y-2">
                    {list.map((s) => {
                      const on = picked.includes(s.id);
                      // One booking is priced in one currency.
                      const otherCurrency = chosen.length > 0 && chosen[0].currency !== s.currency;
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            aria-pressed={on}
                            disabled={otherCurrency}
                            onClick={() => {
                              setSlot(null);
                              setSlots(null);
                              setPicked((p) => (on ? p.filter((x) => x !== s.id) : config.singleService ? [s.id] : [...p, s.id]));
                            }}
                            className={cn(
                              "flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:opacity-40",
                              on ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50",
                            )}
                            style={s.color ? { borderLeftColor: s.color, borderLeftWidth: 4 } : undefined}
                          >
                            <span
                              aria-hidden
                              className={cn(
                                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                                on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                              )}
                            >
                              {on && <Check className="h-3 w-3" />}
                            </span>
                            {s.imageUrl && (
                              // eslint-disable-next-line @next/next/no-img-element -- storage URL of the service photo
                              <img src={s.imageUrl} alt="" referrerPolicy="no-referrer" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block text-base font-medium">{s.name}</span>
                              {s.description && <span className="mt-0.5 block text-sm text-muted-foreground">{s.description}</span>}
                              {s.durationMinutes && (
                                <span className="mt-1 block text-xs text-muted-foreground">About {formatMinutes(s.durationMinutes)}</span>
                              )}
                            </span>
                            {(s.variants.length > 0 ? Math.min(...s.variants.map((v) => v.priceMinor)) : s.priceMinor) > 0 && (
                              <span className="shrink-0 text-base tabular-nums">
                                {s.variants.length > 0 ? "From " : ""}
                                {formatMoneyCode(s.currency, s.variants.length > 0 ? Math.min(...s.variants.map((v) => v.priceMinor)) : s.priceMinor)}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  </div>
                  ))
                  )}
                  {config.services
                    .filter((s) => picked.includes(s.id) && s.variants.length > 0)
                    .map((s) => (
                      variantFields(s)
                    ))}
                  {addOnFields()}
                  {priced && (
                    <p className="flex items-baseline justify-between rounded-lg bg-muted/60 px-4 py-3 text-sm">
                      <span className="text-muted-foreground">Estimated total</span>
                      <span className="text-base font-semibold tabular-nums">{quote ? money(quote.totalMinor) : formatMoneyCode(chosen[0].currency, total)}</span>
                    </p>
                  )}
                </>
              )}

              {label === "When" && only && only.variants.length > 0 && variantFields(only)}
              {label === "When" && only && addOnFields()}

              {label === "When" && config.instant && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Pick a day, then choose a time that suits you. We book it straight away.
                    {notice >= 12 ? ` This service needs at least ${notice >= 48 ? `${Math.round(notice / 24)} days` : `${notice} hours`} notice.` : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {quick.filter(([, value]) => value >= firstDay).map(([text, value]) => (
                      <button
                        key={text}
                        type="button"
                        aria-pressed={date === value}
                        onClick={() => setDate(value)}
                        className={cn(
                          "min-h-11 rounded-full border px-4 text-sm transition-colors",
                          date === value ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted/50",
                        )}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                  <Field label="Or pick a date" type="date" min={firstDay} max={lastDay} value={date} onChange={(e) => setDate(e.target.value)} />
                  {slotsBusy && (
                    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Looking for open times…
                    </p>
                  )}
                  {slotsError && (
                    <p role="alert" className="text-sm text-destructive">
                      {slotsError}
                    </p>
                  )}
                  {date && !slotsBusy && !slotsError && slots && slots.length === 0 && (
                    <p className="rounded-lg bg-muted/60 p-3 text-sm">No times are free on that day. Try another date.</p>
                  )}
                  {!slotsBusy && slots && slots.length > 0 && (
                    <fieldset>
                      <legend className="mb-1.5 text-sm text-muted-foreground">Open times{slotZone ? ` (${slotZone})` : ""}</legend>
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {slots.map((sl) => (
                          <button
                            key={sl.start}
                            type="button"
                            aria-pressed={slot?.start === sl.start}
                            onClick={() => setSlot(sl)}
                            className={cn(
                              "min-h-11 rounded-lg border px-2 text-sm transition-colors",
                              slot?.start === sl.start ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted/50",
                            )}
                          >
                            {sl.time}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  )}
                </>
              )}

              {label === "When" && !config.instant && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Tell us what suits you. We&apos;ll confirm the exact time with you. You can skip this.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {quick.map(([text, value]) => (
                      <button
                        key={text}
                        type="button"
                        aria-pressed={date === value}
                        onClick={() => setDate(date === value ? "" : value)}
                        className={cn(
                          "min-h-11 rounded-full border px-4 text-sm transition-colors",
                          date === value ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted/50",
                        )}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                  <Field label="Or pick a date" type="date" min={today} max={lastDay} value={date} onChange={(e) => setDate(e.target.value)} />
                  <fieldset>
                    <legend className="mb-1.5 text-sm text-muted-foreground">Time of day</legend>
                    <div className="flex flex-wrap gap-2">
                      {WINDOWS.map(([id, text]) => (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={timeOfDay === id}
                          onClick={() => setTimeOfDay(id)}
                          className={cn(
                            "min-h-11 rounded-full border px-4 text-sm transition-colors",
                            timeOfDay === id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted/50",
                          )}
                        >
                          {text}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </>
              )}

              {label === "Your details" && (
                <>
                  {only && !steps.includes("When") && addOnFields()}
                  <dl className="space-y-1.5 rounded-xl bg-muted/50 p-4 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Services</dt>
                      <dd className="text-right">{[...chosen.map((s) => s.name), ...availableAddOns.filter((a) => addOnIds.includes(a.id)).map((a) => a.name)].join(", ")}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Address</dt>
                      <dd className="text-right">{[line1, city, postcode].filter(Boolean).join(", ")}</dd>
                    </div>
                    {config.instant && slot && (
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">Time</dt>
                        <dd className="text-right">{slot.label}</dd>
                      </div>
                    )}
                    {!config.instant && config.askWhen && date && (
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">Preferred</dt>
                        <dd className="text-right">
                          {date} · {WINDOWS.find(([id]) => id === timeOfDay)?.[1]}
                        </dd>
                      </div>
                    )}
                    {quote && quote.tax && quote.taxMinor > 0 && (
                      <>
                        <div className="flex justify-between gap-3 border-t pt-1.5">
                          <dt className="text-muted-foreground">Subtotal</dt>
                          <dd className="tabular-nums">{money(quote.netMinor)}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">
                            {quote.tax.name} ({quote.tax.percent}%{quote.tax.inclusive ? ", included" : ""})
                          </dt>
                          <dd className="tabular-nums">{money(quote.taxMinor)}</dd>
                        </div>
                      </>
                    )}
                    {(quote ? quote.totalMinor > 0 : priced) && (
                      <div className={"flex justify-between gap-3 pt-1.5 font-medium" + (quote?.tax && quote.taxMinor > 0 ? "" : " border-t")}>
                        <dt>{quote ? "Total" : "Estimated total"}</dt>
                        <dd className="tabular-nums">{quote ? money(quote.totalMinor) : formatMoneyCode(chosen[0].currency, total)}</dd>
                      </div>
                    )}
                  </dl>
                  {offeredPay.length > 1 && (
                    <fieldset className="space-y-2 rounded-xl border p-4">
                      <legend className="px-1 text-sm font-medium">How would you like to pay?</legend>
                      {offeredPay.map((c) => (
                        <label key={c} className="flex cursor-pointer items-center gap-3 text-sm">
                          <input type="radio" name="pay-choice" checked={pay === c} onChange={() => setPayChoice(c)} className="h-4 w-4" />
                          <span className="flex-1">
                            {c === "deposit" ? "Pay a deposit now" : c === "full" ? "Pay in full now" : "Pay in person"}
                          </span>
                          {c !== "in_person" && quote && (
                            <span className="tabular-nums">{money(c === "full" ? quote.totalMinor : quote.depositMinor)}</span>
                          )}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {payNow > 0 && (
                    <div className="space-y-1 rounded-xl border p-4 text-sm">
                      <p className="flex justify-between gap-3 font-medium">
                        <span>{pay === "full" ? "To pay now" : "Deposit to pay now"}</span>
                        <span className="tabular-nums">{money(payNow)}</span>
                      </p>
                      <p className="text-muted-foreground">You pay this by card on the next screen to confirm your booking.</p>
                      {config.refundPolicy && <p className="whitespace-pre-line text-muted-foreground">{config.refundPolicy}</p>}
                    </div>
                  )}
                  <Field label="Name" value={name} maxLength={100} autoComplete="name" onChange={(e) => setName(e.target.value)} />
                  <Field label="Email" type="email" value={email} maxLength={200} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
                  <Field label="Phone (optional)" type="tel" value={phone} maxLength={30} autoComplete="tel" onChange={(e) => setPhone(e.target.value)} />
                  <FieldArea label="Anything we should know? (optional)" rows={3} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
                    <span>It&apos;s OK to text me about this request.</span>
                  </label>
                </>
              )}
            </div>

            {error && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>

          {/* Stays in view on a phone, so the next step is never off screen. */}
          <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-2xl border-t bg-card/95 p-4 backdrop-blur sm:px-7">
            <Button
              type="button"
              variant="outline"
              className="h-12 px-5 text-base"
              disabled={busy || step === 0}
              onClick={() => {
                setError("");
                setStep((s) => s - 1);
              }}
            >
              Back
            </Button>
            <Button type="submit" className="h-12 flex-1 text-base sm:flex-none sm:px-8" disabled={busy || (label === "Address" && area?.blocked === true)}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {last ? (payNow > 0 ? `${pay === "full" ? "Pay" : "Pay deposit"} ${money(payNow)}` : "Send request") : "Next"}
            </Button>
          </div>
        </form>
      </PublicCard>
      </div>
      </div>
      {!only && (
      <section aria-labelledby="offer-heading" className="space-y-6">
        <h2 id="offer-heading" className="text-center text-lg font-semibold">
          What we offer
        </h2>
        {groups.map(([category, list]) => (
          <div key={category || "none"}>
            {category && category !== DEFAULT_SERVICE_CATEGORY && <h3 className="mb-3 text-center text-sm font-semibold text-muted-foreground">{category}</h3>}
            <ul className="flex flex-wrap justify-center gap-4">
              {list.map((s) => (
                <li
                  key={s.id}
                  className="flex w-full flex-col overflow-hidden rounded-2xl border bg-card shadow-sm sm:w-[calc(50%-0.5rem)]"
                  style={s.color ? { borderTopColor: s.color, borderTopWidth: 4 } : undefined}
                >
                  {s.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- storage URL of the service photo
                    <img src={s.imageUrl} alt="" referrerPolicy="no-referrer" className="aspect-video w-full object-cover" />
                  )}
                  <div className="flex flex-1 flex-col p-4">
                    <p className="text-base font-semibold">{s.name}</p>
                    {s.description && <p className="mt-1 line-clamp-4 text-sm text-muted-foreground">{s.description}</p>}
                    <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                      <span className="text-sm text-muted-foreground">
                        {s.priceMinor > 0 ? formatMoneyCode(s.currency, s.priceMinor) : ""}
                        {s.priceMinor > 0 && s.durationMinutes ? " · " : ""}
                        {s.durationMinutes ? `About ${formatMinutes(s.durationMinutes)}` : ""}
                      </span>
                      <Button type="button" size="sm" onClick={() => toForm(s.id)}>
                        Book
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      )}
    </div>
  );
}
