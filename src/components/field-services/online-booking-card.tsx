"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, Loader2, Monitor, RefreshCw, Smartphone, Tablet } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFieldData } from "@/components/field-services/field-data";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { SELECT_CLASS } from "@/components/field-services/field-ui";
import { usePipelines } from "@/hooks/use-pipelines";
import { jobTerms } from "@/lib/field-services/terms";
import { BOOKING_STYLES, BOOKING_STYLE_IDS, bookingStyleOf, type BookingStyleId } from "@/lib/field-services/booking-styles";
import { cn } from "@/lib/utils";

const DEFAULT_ACCENT = "#2563eb";
const PAGES_SAVED = "field-pages-saved";

async function patch(url: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      window.dispatchEvent(new Event(PAGES_SAVED));
      return true;
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    toast.error(data.error ?? "That didn't save.");
  } catch {
    toast.error("No connection. Try again.");
  }
  return false;
}

/** The public booking page: switch, which services it offers, wording and the link to share. */
export function OnlineBookingCard() {
  const { subAccountId } = useSubAccount();
  const { config, reload } = useFieldConfig();
  const { services } = useFieldData();
  const url = `/api/sub-accounts/${subAccountId}/field-services/config`;

  const [intro, setIntro] = useState("");
  const [doneMessage, setDoneMessage] = useState("");
  const [depositPercent, setDepositPercent] = useState("20");
  const [refundPolicy, setRefundPolicy] = useState("");
  const [busy, setBusy] = useState(false);
  const [flags, setFlags] = useState<{
    onlineBookingEnabled?: boolean;
    bookingAskWhen?: boolean;
    bookingCreateDeal?: boolean;
    bookingSingleService?: boolean;
    bookingInstant?: boolean;
    bookingDepositEnabled?: boolean;
    bookingPayInFull?: boolean;
    bookingPayInPerson?: boolean;
    bookingFooterEnabled?: boolean;
  }>({});
  const { pipelines } = usePipelines();
  const [dealPipeline, setDealPipeline] = useState<string | null>(null);
  const [dealStage, setDealStage] = useState<string | null>(null);
  const filled = useRef(false);

  useEffect(() => {
    if (!config || filled.current) return;
    filled.current = true;
    setIntro(config.bookingIntro ?? "");
    setDoneMessage(config.bookingDoneMessage ?? "");
    setDepositPercent(String(config.bookingDepositPercent ?? 20));
    setRefundPolicy(config.bookingRefundPolicy ?? "");
  }, [config]);

  if (!config) return null;
  const terms = jobTerms(config);
  const enabled = flags.onlineBookingEnabled ?? config.onlineBookingEnabled === true;
  const askWhen = flags.bookingAskWhen ?? config.bookingAskWhen !== false;
  const instant = flags.bookingInstant ?? config.bookingInstant === true;
  const deposit = flags.bookingDepositEnabled ?? config.bookingDepositEnabled === true;
  const payFull = flags.bookingPayInFull ?? config.bookingPayInFull === true;
  const payInPerson = flags.bookingPayInPerson ?? config.bookingPayInPerson === true;
  const footer = flags.bookingFooterEnabled ?? config.bookingFooterEnabled !== false;
  const footerFields = config.bookingFooterFields ?? ["name", "address", "phone", "email", "website"];
  const singleService = instant || (flags.bookingSingleService ?? config.bookingSingleService === true);
  const createDeal = flags.bookingCreateDeal ?? config.bookingCreateDeal === true;
  const pipelineId = dealPipeline ?? config.bookingDealPipelineId ?? "default";
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0];
  const openStages = (pipeline?.stages ?? []).filter((st) => !st.terminal);
  const stageId = openStages.some((st) => st.id === (dealStage ?? config.bookingDealStageId))
    ? (dealStage ?? config.bookingDealStageId)
    : (openStages[0]?.id ?? "new");
  const offered = services.filter((s) => s.kind === "service" && s.active !== false);
  const bookable = offered.filter((s) => (config.bookingServiceIds ?? []).includes(s.id));
  const link = typeof window === "undefined" ? "" : `${window.location.origin}/book-service/${subAccountId}`;

  async function saveDealStage(pipelineId: string, stageId: string) {
    setDealPipeline(pipelineId);
    setDealStage(stageId);
    if (!(await patch(url, { bookingDealPipelineId: pipelineId, bookingDealStageId: stageId }))) {
      setDealPipeline(null);
      setDealStage(null);
    } else {
      reload();
    }
  }

  async function enableDeals(on: boolean) {
    setFlags((f) => ({ ...f, bookingCreateDeal: on }));
    // Save the pipeline and stage on screen too, so the deal lands where the card says it will.
    const ok = await patch(
      url,
      on && pipeline
        ? { bookingCreateDeal: true, bookingDealPipelineId: pipeline.id, bookingDealStageId: stageId }
        : { bookingCreateDeal: on },
    );
    if (!ok) setFlags((f) => ({ ...f, bookingCreateDeal: undefined }));
    else reload();
  }

  async function flag(
    key: "onlineBookingEnabled" | "bookingAskWhen" | "bookingCreateDeal" | "bookingSingleService" | "bookingInstant" | "bookingDepositEnabled" | "bookingPayInFull" | "bookingPayInPerson" | "bookingFooterEnabled",
    value: boolean,
  ) {
    setFlags((f) => ({ ...f, [key]: value }));
    const ok = await patch(url, { [key]: value });
    if (!ok) setFlags((f) => ({ ...f, [key]: undefined }));
    else reload();
  }

  async function setChangeHours(hours: number) {
    if (await patch(url, { customerChangeHours: hours })) {
      toast.success("Saved.");
      reload();
    }
  }

  async function setMaxDays(days: number) {
    if (await patch(url, { bookingMaxDays: days })) {
      toast.success("Saved.");
      reload();
    }
  }

  async function saveDetails() {
    setBusy(true);
    const ok = await patch(url, {
      bookingIntro: intro,
      bookingDoneMessage: doneMessage,
      bookingDepositPercent: Number.parseInt(depositPercent, 10) || 20,
      bookingRefundPolicy: refundPolicy,
    });
    setBusy(false);
    if (ok) {
      toast.success("Booking page saved.");
      reload();
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        Online booking
        <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
          Beta
        </span>
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A public page where customers enter their address, pick services and a preferred time, and send a request.
        It checks your service areas, then creates the customer and {terms.job} for you to schedule.
      </p>
      <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox checked={enabled} onCheckedChange={(v) => void flag("onlineBookingEnabled", v === true)} />
        Turn on the booking page
      </label>

      {enabled && (
        <div className="mt-5 space-y-5">
          <div>
            <Label className="mb-2 block text-xs font-medium text-muted-foreground">Services customers can pick</Label>
            {offered.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Add services on the Services &amp; areas tab first. The page stays unavailable until one is bookable online.
              </p>
            ) : bookable.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                None yet. Switch on Bookable online when you add or edit a service on the Services &amp; areas tab. The page stays
                unavailable until one is.
              </p>
            ) : (
              <>
                <ul className="space-y-1">
                  {bookable.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 text-sm">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/40"
                        style={s.color ? { backgroundColor: s.color } : undefined}
                      />
                      {s.name}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">Change this with Bookable online on each service.</p>
              </>
            )}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={singleService}
              disabled={instant}
              onCheckedChange={(v) => void flag("bookingSingleService", v === true)}
            />
            One service per booking
          </label>
          <div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={instant} onCheckedChange={(v) => void flag("bookingInstant", v === true)} />
              Instant booking: customers pick an open time and it is booked straight away
            </label>
            <p className="mt-1 pl-6 text-xs text-muted-foreground">
              Open times come from each person&apos;s working hours, time off, the services and areas they cover and what is already scheduled. The least
              busy person who is free is booked, and they and the customer are told. Needs staff with working hours, a length on the service and one service
              per booking.
            </p>
          </div>
          {!instant && (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={askWhen} onCheckedChange={(v) => void flag("bookingAskWhen", v === true)} />
              Ask for a preferred date and time of day
            </label>
          )}
          {(askWhen || instant) && (
            <div className="sm:max-w-xs">
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">How far ahead customers can ask</Label>
              <select
                className={SELECT_CLASS}
                value={config.bookingMaxDays ?? 90}
                onChange={(e) => void setMaxDays(Number(e.target.value))}
              >
                <option value={30}>Up to 30 days</option>
                <option value={60}>Up to 60 days</option>
                <option value={90}>Up to 90 days</option>
              </select>
            </div>
          )}

          <div className="sm:max-w-md">
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Customers can cancel or move a visit</Label>
            <select
              className={SELECT_CLASS}
              value={config.customerChangeHours ?? 72}
              onChange={(e) => void setChangeHours(Number(e.target.value))}
            >
              <option value={0}>Never, they contact us</option>
              <option value={24}>Until 24 hours before</option>
              <option value={48}>Until 48 hours before</option>
              <option value={72}>Until 72 hours before</option>
              <option value={96}>Until 4 days before</option>
              <option value={168}>Until 7 days before</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              On the customer&apos;s project page. Closer to the visit they see your phone number instead. Moving a visit needs instant booking.
            </p>
          </div>

          <div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={createDeal} onCheckedChange={(v) => void enableDeals(v === true)} />
              Also add each request to my pipeline as a deal
            </label>
            {createDeal && pipeline && (
              <div className="mt-2 grid gap-3 sm:max-w-xl sm:grid-cols-2">
                <div>
                  <Label className="mb-1 block text-xs font-medium text-muted-foreground">Pipeline</Label>
                  <select
                    className={SELECT_CLASS}
                    value={pipeline.id}
                    onChange={(e) => {
                      const p = pipelines.find((x) => x.id === e.target.value);
                      const first = p?.stages.find((st) => !st.terminal);
                      if (p && first) void saveDealStage(p.id, first.id);
                    }}
                  >
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="mb-1 block text-xs font-medium text-muted-foreground">Stage</Label>
                  <select
                    className={SELECT_CLASS}
                    value={stageId}
                    onChange={(e) => void saveDealStage(pipeline.id, e.target.value)}
                  >
                    {openStages.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border p-3 sm:max-w-xl">
            <p className="text-sm font-medium">How customers can pay when they book</p>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={deposit} onCheckedChange={(v) => void flag("bookingDepositEnabled", v === true)} />
              Pay a deposit by card
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={payFull} onCheckedChange={(v) => void flag("bookingPayInFull", v === true)} />
              Pay in full by card
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={payInPerson} onCheckedChange={(v) => void flag("bookingPayInPerson", v === true)} />
              Pay in person
            </label>
            <p className="text-xs text-muted-foreground">
              Customers pick from the ones you tick; with only one ticked there is nothing to pick. The card choices need card payments connected in
              Settings, Payments and a currency with two decimals; when they cannot be offered the page falls back to paying in person. A time not
              paid for is released after 30 minutes. Money paid comes off the first invoice for the {terms.job}, after tax. You can set a different
              deposit percentage, or none, on each service.
            </p>
            {(deposit || payFull) && (
              <div className="grid gap-3">
                <div className={"sm:max-w-[10rem]" + (deposit ? "" : " hidden")}>
                  <Label className="mb-1 block text-xs font-medium text-muted-foreground">Deposit (% of the price)</Label>
                  <Input
                    value={depositPercent}
                    inputMode="numeric"
                    onChange={(e) => setDepositPercent(e.target.value.replace(/\D/g, "").slice(0, 3))}
                  />
                </div>
                <div>
                  <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Cancellation and refund policy (shown beside the card payment)
                  </Label>
                  <textarea
                    value={refundPolicy}
                    maxLength={600}
                    rows={3}
                    onChange={(e) => setRefundPolicy(e.target.value)}
                    placeholder="The deposit is refundable if you cancel at least 48 hours before the visit."
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border p-3 sm:max-w-xl">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <Checkbox checked={footer} onCheckedChange={(v) => void flag("bookingFooterEnabled", v === true)} />
              Show a footer with my business name and details
            </label>
            {footer && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Choose what shows. The details come from Settings, Business details, and a missing phone or email falls back to the account contact.
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {(
                    [
                      ["name", "Business name"],
                      ["address", "Address"],
                      ["phone", "Phone"],
                      ["email", "Email"],
                      ["website", "Website"],
                    ] as const
                  ).map(([id, label]) => (
                    <label key={id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={footerFields.includes(id)}
                        onCheckedChange={async (v) => {
                          const next = v === true ? [...footerFields, id] : footerFields.filter((f) => f !== id);
                          if (await patch(url, { bookingFooterFields: next })) reload();
                        }}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:max-w-xl">
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">Intro under the title (optional)</Label>
              <Input value={intro} maxLength={400} onChange={(e) => setIntro(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">Extra message after sending (optional)</Label>
              <Input value={doneMessage} maxLength={400} onChange={(e) => setDoneMessage(e.target.value)} />
            </div>
          </div>

          <Button size="sm" disabled={busy} onClick={() => void saveDetails()}>
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />} Save booking page
          </Button>

          <div className="rounded-lg border p-3">
            <p className="text-xs font-medium text-muted-foreground">Your booking page</p>
            <p className="mt-1 break-all text-sm">{link}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(link).then(() => toast.success("Link copied."));
                }}
              >
                <Copy className="mr-2 h-3.5 w-3.5" /> Copy link
              </Button>
              <Button size="sm" variant="outline" render={<a href={link} target="_blank" rel="noreferrer" />}>
                <ExternalLink className="mr-2 h-3.5 w-3.5" /> View page
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Out-of-area addresses follow your out-of-area setting. Customers get a confirmation text or email, and a task
              is added for the office. Save your service choices before sharing the link.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

/** Lets customers who have made a request sign in with a code to see their requests and projects. */
export function CustomerPortalCard() {
  const { subAccountId } = useSubAccount();
  const { config, reload } = useFieldConfig();
  const { subAccount } = useSubAccount();
  const [flag, setFlag] = useState<boolean | null>(null);
  const [portalName, setPortalName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const nameFilled = useRef(false);
  useEffect(() => {
    if (!config || nameFilled.current) return;
    nameFilled.current = true;
    setPortalName(config.portalName ?? "");
  }, [config]);
  if (!config) return null;
  const terms = jobTerms(config);
  const on = flag ?? config.customerPortalEnabled === true;
  const nameDirty = portalName.trim() !== (config.portalName ?? "");

  async function saveName() {
    setSavingName(true);
    const ok = await patch(`/api/sub-accounts/${subAccountId}/field-services/config`, { portalName });
    setSavingName(false);
    if (ok) {
      toast.success("Portal name saved.");
      reload();
    }
  }
  const link = typeof window === "undefined" ? "" : `${window.location.origin}/customer/${subAccountId}`;

  async function toggle(value: boolean) {
    setFlag(value);
    const ok = await patch(`/api/sub-accounts/${subAccountId}/field-services/config`, { customerPortalEnabled: value });
    if (!ok) setFlag(null);
    else reload();
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        Customer portal
        <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
          Beta
        </span>
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Customers who have made a request sign in with a one-time code emailed to the address they gave us, with no password.
        They see their requests and {terms.jobs}, who is coming and when, and can open the full tracking page to approve extra work.
      </p>
      <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox checked={on} onCheckedChange={(v) => void toggle(v === true)} />
        Turn on the customer portal
      </label>
      {on && (
        <div className="mt-4 sm:max-w-md">
          <Label className="mb-1 block text-xs font-medium text-muted-foreground">Portal name (optional)</Label>
          <div className="flex gap-2">
            <Input
              value={portalName}
              maxLength={60}
              placeholder={subAccount?.name || "Your business"}
              onChange={(e) => setPortalName(e.target.value)}
            />
            <Button size="sm" className="h-9" disabled={savingName || !nameDirty} onClick={() => void saveName()}>
              {savingName && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Save name
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Shown at the top of the portal and in its sign-in code email. Leave empty to use the workspace name.
          </p>
        </div>
      )}
      {on && (
        <div className="mt-4 rounded-lg border p-3">
          <p className="text-xs font-medium text-muted-foreground">Portal link</p>
          <p className="mt-1 break-all text-sm">{link}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(link).then(() => toast.success("Link copied."));
              }}
            >
              <Copy className="mr-2 h-3.5 w-3.5" /> Copy link
            </Button>
            <Button size="sm" variant="outline" render={<a href={link} target="_blank" rel="noreferrer" />}>
              <ExternalLink className="mr-2 h-3.5 w-3.5" /> View page
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Only people with an existing request or {terms.job} can sign in. Codes are never saved in the customer&apos;s message
            thread.
          </p>
        </div>
      )}
    </section>
  );
}

/** Colour, theme and logo shared by the booking page and the customer portal. */
/** The booking page a website build made: its address, the site it matches and its own look. */
export function SiteBookingCard() {
  const { subAccountId } = useSubAccount();
  const { config, reload } = useFieldConfig();
  const url = `/api/sub-accounts/${subAccountId}/field-services/config`;
  const [accent, setAccent] = useState<string | null>(null);
  const [theme, setTheme] = useState<string | null>(null);
  const [style, setStyle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!config) return null;
  const site = config.siteBooking;

  if (!site) {
    return (
      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Website booking page</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing here yet. When you build a website with the Website tool and leave &ldquo;Send booking buttons to a matching
          booking page&rdquo; ticked, a second booking page is made here. It takes the website&apos;s colours and theme, and the
          site&apos;s booking buttons and menu link go to it. Your standard booking page is never changed.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          It needs the booking page switched on with at least one service that is bookable online.
        </p>
      </section>
    );
  }

  const colour = accent ?? site.accent;
  const mode = theme ?? site.theme;
  const styleId = bookingStyleOf(style ?? site.style).id;
  const address = `${window.location.origin}/book-service/${subAccountId}/site`;

  async function saveLook() {
    setBusy(true);
    const ok = await patch(url, { siteBookingLook: { accent: colour, theme: mode, style: styleId } });
    setBusy(false);
    if (ok) {
      toast.success("Look saved.");
      setAccent(null);
      setTheme(null);
      setStyle(null);
      reload();
    }
  }

  async function remove() {
    if (!window.confirm("Remove the website booking page? The website's booking buttons will stop working until you build the site again.")) return;
    setBusy(true);
    const ok = await patch(url, { siteBooking: null });
    setBusy(false);
    if (ok) {
      toast.success("Website booking page removed.");
      reload();
    }
  }

  return (
    <section className="space-y-5 rounded-2xl border bg-card p-6">
      <div>
        <h2 className="text-base font-semibold">Website booking page</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The same booking page, with the same services, hours and bookings, styled to match{" "}
          <span className="font-medium text-foreground">{site.websiteName}</span>. Your standard booking page is not affected.
        </p>
      </div>

      <div>
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">Address for the website</Label>
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded-md bg-muted px-2 py-1.5 text-xs">{address}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(address).then(() => toast.success("Address copied."))}
          >
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.open(address, "_blank", "noopener,noreferrer")}>
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {site.siteUrl ? (
            <>
              The website is at{" "}
              <a className="underline-offset-2 hover:underline" href={site.siteUrl} target="_blank" rel="noopener noreferrer">
                {site.siteUrl.replace(/^https?:\/\//i, "")}
              </a>
              , and the booking page links back to it.
            </>
          ) : (
            "The website is still building. The back link appears once it is published."
          )}
        </p>
      </div>

      <div className="sm:max-w-xl">
        <StylePicker
          value={styleId}
          onPick={(id) => {
            setStyle(id);
            if (id !== "default") {
              setAccent(BOOKING_STYLES[id].accent);
              setTheme(BOOKING_STYLES[id].theme);
            }
          }}
        />
      </div>

      <div className="grid gap-4 sm:max-w-xl sm:grid-cols-2">
        <div>
          <Label className="mb-1 block text-xs font-medium text-muted-foreground">Brand colour</Label>
          <input
            type="color"
            aria-label="Website booking page colour"
            value={colour || DEFAULT_ACCENT}
            onChange={(e) => setAccent(e.target.value)}
            className="h-9 w-14 cursor-pointer rounded-md border bg-background p-1"
          />
        </div>
        <div>
          <Label className="mb-1 block text-xs font-medium text-muted-foreground">Theme</Label>
          <select className={SELECT_CLASS} value={mode} onChange={(e) => setTheme(e.target.value)}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="auto">Match the customer&apos;s device</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {site.lookEdited
          ? "You changed this look, so rebuilding the website keeps it."
          : "Started from the website's settings. The builder picks most colours itself, so adjust the colour here to match the live site; a rebuild then keeps your choice."}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void saveLook()}>
          {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />} Save look
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>
          Remove this page
        </Button>
      </div>
    </section>
  );
}

/** The design directions, matching the website builder's, as a row of choices. */
function StylePicker({ value, onPick }: { value: BookingStyleId; onPick: (id: BookingStyleId) => void }) {
  return (
    <div>
      <Label className="mb-1 block text-xs font-medium text-muted-foreground">Style</Label>
      <div className="grid gap-2 sm:grid-cols-2">
        {BOOKING_STYLE_IDS.map((id) => {
          const st = BOOKING_STYLES[id];
          const on = id === value;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(id)}
              className={`flex items-start gap-2 rounded-lg border p-3 text-left transition-colors ${on ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
            >
              <span aria-hidden className="mt-0.5 h-4 w-4 shrink-0 rounded-full border" style={{ backgroundColor: st.accent }} />
              <span>
                <span className="block text-sm font-medium">{st.label}</span>
                <span className="block text-xs text-muted-foreground">{st.blurb}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Matches the website builder&apos;s design directions. Picking one fills in its colour and theme, which you can still change.
      </p>
    </div>
  );
}

export function PublicLookCard() {
  const { subAccountId, subAccount } = useSubAccount();
  const { config, reload } = useFieldConfig();
  const url = `/api/sub-accounts/${subAccountId}/field-services/config`;
  const [accent, setAccent] = useState<string | null>(null);
  const [theme, setTheme] = useState<string | null>(null);
  const [style, setStyle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!config) return null;
  const colour = accent ?? config.bookingAccent ?? "";
  const mode = theme ?? config.bookingTheme ?? "light";
  const styleId = bookingStyleOf(style ?? config.bookingStyle).id;
  const logo = subAccount?.logoUrl && /^https?:\/\/.+/i.test(subAccount.logoUrl) ? subAccount.logoUrl : null;

  async function save() {
    setBusy(true);
    const ok = await patch(url, { bookingAccent: colour, bookingTheme: mode, bookingStyle: styleId });
    setBusy(false);
    if (ok) {
      toast.success("Look saved.");
      reload();
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <h2 className="text-base font-semibold">Booking page and portal look</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The style, colour, theme and logo your customers see on the booking page and the customer portal.
      </p>
      <div className="mt-4 sm:max-w-xl">
        <StylePicker
          value={styleId}
          onPick={(id) => {
            setStyle(id);
            if (id !== "default") {
              setAccent(BOOKING_STYLES[id].accent);
              setTheme(BOOKING_STYLES[id].theme);
            }
          }}
        />
      </div>
      <div className="mt-4 grid gap-4 sm:max-w-xl sm:grid-cols-2">
        <div>
          <Label className="mb-1 block text-xs font-medium text-muted-foreground">Brand colour</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Brand colour"
              value={colour || DEFAULT_ACCENT}
              onChange={(e) => setAccent(e.target.value)}
              className="h-9 w-14 cursor-pointer rounded-md border bg-background p-1"
            />
            {colour && (
              <Button size="sm" variant="outline" onClick={() => setAccent(styleId === "default" ? "" : BOOKING_STYLES[styleId].accent)}>
                Use default
              </Button>
            )}
          </div>
        </div>
        <div>
          <Label className="mb-1 block text-xs font-medium text-muted-foreground">Theme</Label>
          <select className={SELECT_CLASS} value={mode} onChange={(e) => setTheme(e.target.value)}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="auto">Match the customer&apos;s device</option>
          </select>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3 rounded-lg border p-3">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- workspace-supplied URL, dimensions unknown
          <img src={logo} alt="" referrerPolicy="no-referrer" className="h-10 max-w-[8rem] rounded object-contain" />
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded bg-muted text-xs text-muted-foreground">None</span>
        )}
        <p className="text-sm text-muted-foreground">
          {logo
            ? "This is your logo from Settings → Branding. Change it there and both pages update."
            : "No logo yet. Add one in Settings → Branding and it appears on both pages."}
        </p>
      </div>
      <Button size="sm" className="mt-4" disabled={busy} onClick={() => void save()}>
        {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />} Save look
      </Button>
    </section>
  );
}

const DEVICES = [
  { id: "desktop", label: "Desktop", width: 1280, height: 760, frame: 0, Icon: Monitor },
  { id: "tablet", label: "Tablet", width: 768, height: 1024, frame: 8, Icon: Tablet },
  { id: "mobile", label: "Mobile", width: 390, height: 780, frame: 10, Icon: Smartphone },
] as const;

/** The real public pages shown at true device width, scaled to fit, so look changes can be checked on each screen size. */
export function PagePreviewCard({ page }: { page: "book-service" | "book-service-site" | "customer" }) {
  const { subAccountId } = useSubAccount();
  const { config } = useFieldConfig();
  const [device, setDevice] = useState<(typeof DEVICES)[number]["id"]>("mobile");
  const [bump, setBump] = useState(0);
  const [avail, setAvail] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const ready = config !== null;

  // Any save made on this tab reloads the frame, since the page reads the saved settings.
  useEffect(() => {
    const onSaved = () => setBump((b) => b + 1);
    window.addEventListener(PAGES_SAVED, onSaved);
    return () => window.removeEventListener(PAGES_SAVED, onSaved);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setAvail(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  if (!config) return null;
  const on =
    page === "customer"
      ? config.customerPortalEnabled === true
      : config.onlineBookingEnabled === true && (page === "book-service" || !!config.siteBooking);
  const path = page === "book-service-site" ? `book-service/${subAccountId}/site` : `${page}/${subAccountId}`;
  const label = page === "customer" ? "customer portal" : page === "book-service-site" ? "website booking page" : "booking page";
  const d = DEVICES.find((x) => x.id === device) ?? DEVICES[2];
  const outerW = d.width + d.frame * 2;
  const outerH = d.height + d.frame * 2;
  const scale = avail > 0 ? Math.min(1, avail / outerW) : 1;

  return (
    <section className="rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Preview</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your {label} as customers see it. It reloads when you save a change.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="Screen size">
            {DEVICES.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setDevice(id)}
                aria-pressed={device === id}
                aria-label={label}
                title={label}
                className={
                  "rounded-md px-2.5 py-1.5 " +
                  (device === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")
                }
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          <Button variant="outline" size="icon" aria-label="Reload preview" onClick={() => setBump((b) => b + 1)}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {!on && (
        <p className="mt-3 text-xs text-muted-foreground">
          This page is switched off, so customers see a &ldquo;not available&rdquo; message. Turn it on to preview the real page.
        </p>
      )}
      <div ref={box} className="mt-4 w-full rounded-xl bg-muted/40 p-3">
        <div className="mx-auto" style={{ width: outerW * scale, height: outerH * scale }}>
          <div
            className={cn(
              "overflow-hidden bg-background",
              d.id === "mobile" && "rounded-[2.5rem] border-[10px] border-neutral-900",
              d.id === "tablet" && "rounded-3xl border-8 border-neutral-900",
              d.id === "desktop" && "rounded-lg border",
            )}
            style={{ width: outerW, height: outerH, transform: `scale(${scale})`, transformOrigin: "top left" }}
          >
            <iframe
              key={`${page}-${bump}`}
              title={`Preview of the ${label}`}
              src={`/${path}`}
              className="block h-full w-full border-0 bg-background"
            />
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        The preview is the live page. Sending a request from it creates a real request.
      </p>
    </section>
  );
}
