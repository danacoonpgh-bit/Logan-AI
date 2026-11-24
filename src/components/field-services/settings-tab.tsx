"use client";

import { ServiceCategoriesCard } from "@/components/field-services/service-categories-card";
import { TimeKindsCard } from "@/components/field-services/time-kinds-card";
import { RouteSuggestionsCard } from "@/components/field-services/route-suggestions-card";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BillingTypeSelect, billingTypeHints, useFieldConfig } from "@/components/field-services/timesheets-ui";
import { BUTTON_COLORS, BUTTON_COLOR_IDS, type ButtonColorId } from "@/lib/field-services/button-colors";
import { DEFAULT_JOB_WORD, DEFAULT_JOB_WORD_PLURAL, DEFAULT_LABOUR_WORD, DEFAULT_ACTIVITY_WORD, MAX_JOB_WORD_LENGTH, jobTerms, DEFAULT_WORKER_WORD, DEFAULT_WORKER_WORD_PLURAL, workerTerms, withArticleCap } from "@/lib/field-services/terms";
import type { FieldServicesConfig } from "@/types/field-services";
import { cn } from "@/lib/utils";
import { SELECT_CLASS } from "@/components/field-services/field-ui";
import { workspaceCurrencyOf } from "@/lib/field-services/money";

const CURRENCIES: { code: string; name: string }[] = [
  { code: "USD", name: "US dollar" },
  { code: "AUD", name: "Australian dollar" },
  { code: "NZD", name: "New Zealand dollar" },
  { code: "CAD", name: "Canadian dollar" },
  { code: "GBP", name: "British pound" },
  { code: "EUR", name: "Euro" },
  { code: "CHF", name: "Swiss franc" },
  { code: "SEK", name: "Swedish krona" },
  { code: "NOK", name: "Norwegian krone" },
  { code: "DKK", name: "Danish krone" },
  { code: "JPY", name: "Japanese yen" },
  { code: "SGD", name: "Singapore dollar" },
  { code: "HKD", name: "Hong Kong dollar" },
  { code: "ZAR", name: "South African rand" },
  { code: "INR", name: "Indian rupee" },
  { code: "AED", name: "UAE dirham" },
  { code: "MXN", name: "Mexican peso" },
  { code: "BRL", name: "Brazilian real" },
  { code: "PHP", name: "Philippine peso" },
  { code: "MYR", name: "Malaysian ringgit" },
];

async function save(url: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return true;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  toast.error(data.error ?? "That didn't work.");
  return false;
}

function ColorPicker({
  label,
  value,
  onChange,
  sample,
}: {
  label: string;
  value: ButtonColorId;
  onChange: (v: ButtonColorId) => void;
  sample: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-sm font-medium">{label}</Label>
        <span
          className={cn(
            "inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium",
            value === "default" ? "bg-primary text-primary-foreground" : BUTTON_COLORS[value].classes,
          )}
        >
          {sample}
        </span>
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {BUTTON_COLOR_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={value === id}
            aria-label={BUTTON_COLORS[id].label}
            title={BUTTON_COLORS[id].label}
            onClick={() => onChange(id)}
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-full border-2 transition-transform active:scale-95",
              value === id ? "border-foreground" : "border-transparent hover:border-muted-foreground/40",
            )}
          >
            <span className={cn("flex h-7 w-7 items-center justify-center rounded-full", BUTTON_COLORS[id].swatch)}>
              {value === id && <Check className="h-4 w-4 text-white mix-blend-difference" />}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsTab({ onSaved }: { onSaved?: () => void }) {
  const { subAccountId, isAdmin } = useSubAccount();
  const { config, reload } = useFieldConfig();
  const url = `/api/sub-accounts/${subAccountId}/field-services/config`;

  const [word, setWord] = useState(DEFAULT_JOB_WORD);
  const [plural, setPlural] = useState(DEFAULT_JOB_WORD_PLURAL);
  const [labour, setLabour] = useState(DEFAULT_LABOUR_WORD);
  const [activity, setActivity] = useState(DEFAULT_ACTIVITY_WORD);
  const [person, setPerson] = useState(DEFAULT_WORKER_WORD);
  const [people, setPeople] = useState(DEFAULT_WORKER_WORD_PLURAL);
  const [minMinutes, setMinMinutes] = useState("10");
  const [maxHours, setMaxHours] = useState("10");
  const [submitColor, setSubmitColor] = useState<ButtonColorId>("default");
  const [unlockColor, setUnlockColor] = useState<ButtonColorId>("default");
  const [saving, setSaving] = useState<string | null>(null);
  const [currencyDraft, setCurrencyDraft] = useState("USD");
  const [taxName, setTaxName] = useState("Tax");
  const [taxPercent, setTaxPercent] = useState("");
  const [flags, setFlags] = useState<Partial<FieldServicesConfig>>({});

  const filled = useRef(false);
  useEffect(() => {
    // Fill the fields once; later reloads must not wipe edits in another card.
    if (!config || filled.current) return;
    filled.current = true;
    setWord(config.jobWord);
    setPlural(config.jobWordPlural);
    setLabour(config.labourWord ?? DEFAULT_LABOUR_WORD);
    setActivity(config.activityWord ?? DEFAULT_ACTIVITY_WORD);
    setPerson(config.workerWord ?? DEFAULT_WORKER_WORD);
    setPeople(config.workerWordPlural ?? DEFAULT_WORKER_WORD_PLURAL);
    setMinMinutes(String(config.minEntryMinutes));
    setMaxHours(String(config.maxDayHours));
    setCurrencyDraft(workspaceCurrencyOf(config));
    setTaxName(config.taxName ?? "Tax");
    setTaxPercent(config.taxPercent ? String(config.taxPercent) : "");
    setSubmitColor((config.submitButtonColor as ButtonColorId) ?? "default");
    setUnlockColor((config.unlockButtonColor as ButtonColorId) ?? "default");
  }, [config]);

  async function run(key: string, body: Record<string, unknown>, done: string) {
    setSaving(key);
    const ok = await save(url, body);
    setSaving(null);
    if (!ok) return;
    toast.success(done);
    reload();
    onSaved?.();
  }

  async function setFlag(key: keyof FieldServicesConfig, value: unknown) {
    setFlags((f) => ({ ...f, [key]: value }));
    const ok = await save(url, { [key]: value });
    if (!ok) setFlags((f) => ({ ...f, [key]: undefined }));
    else {
      reload();
      onSaved?.();
    }
  }

  if (!isAdmin) {
    return (
      <section className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        Only admins can change these settings.
      </section>
    );
  }
  if (!config) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
      </p>
    );
  }

  const terms = jobTerms(config);
  const wt = workerTerms(config);
  const val = <K extends keyof FieldServicesConfig>(key: K): FieldServicesConfig[K] =>
    (flags[key] !== undefined ? flags[key] : config[key]) as FieldServicesConfig[K];
  const spin = (id: string) => (saving === id ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Currency</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One currency for everything in Field Services: {terms.jobs}, services, rate cards, staff rates, expenses, invoices and
          reports. There are no exceptions, so amounts never mix. Nothing is converted. When you choose it, existing {terms.jobs}, rate
          cards, staff rates and services are relabelled with the same numbers. It locks once an invoice, estimate, payment or
          expense exists.
        </p>
        {!config.currency && (
          <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
            Not chosen yet. New work uses USD until you save one.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="ws-currency" className="mb-1 block text-xs font-medium text-muted-foreground">
              Workspace currency
            </Label>
            <select
              id="ws-currency"
              value={currencyDraft}
              onChange={(e) => setCurrencyDraft(e.target.value)}
              className={cn(SELECT_CLASS, "w-64")}
            >
              {!CURRENCIES.some((c) => c.code === currencyDraft) && <option value={currencyDraft}>{currencyDraft}</option>}
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            disabled={saving !== null || (!!config.currency && currencyDraft === config.currency)}
            onClick={() => void run("currency", { currency: currencyDraft }, "Currency saved.")}
          >
            {spin("currency")} Save currency
          </Button>
        </div>
      </section>

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Tax</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One rate for the whole workspace, applied to online bookings and to the invoices and estimates made from
          them. Leave the rate empty for no tax. Existing {terms.jobs} stay as they are, and each new booking keeps the
          rate it was made at.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Name</Label>
            <Input value={taxName} onChange={(e) => setTaxName(e.target.value.slice(0, 30))} placeholder="GST" className="w-32" />
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Rate (%)</Label>
            <Input
              value={taxPercent}
              inputMode="decimal"
              onChange={(e) => setTaxPercent(e.target.value.replace(/[^0-9.]/g, "").slice(0, 5))}
              placeholder="10"
              className="w-24"
            />
          </div>
          <Button
            size="sm"
            disabled={saving !== null}
            onClick={() => void run("tax", { taxName, taxPercent: taxPercent.trim() === "" ? 0 : Number(taxPercent) }, "Tax saved.")}
          >
            {spin("tax")} Save tax
          </Button>
        </div>
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={(flags.pricesIncludeTax ?? config.pricesIncludeTax) === true}
            onCheckedChange={(v) => void setFlag("pricesIncludeTax", v === true)}
          />
          Prices already include tax
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          On: the prices you set on services and add-ons are what the customer pays, and the tax is shown inside
          them. Off: tax is added on top.
        </p>
      </section>

      <ServiceCategoriesCard />

      {val("timesheetsEnabled") === true && <TimeKindsCard />}

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Invoices</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          How long customers have to pay an invoice made from a {terms.job}. You can still change it on each invoice before sending.
        </p>
        <Label htmlFor="invoice-due" className="mt-3 block text-xs font-medium text-muted-foreground">
          Payment due
        </Label>
        <select
          id="invoice-due"
          value={val("invoiceDueDays") === null ? "" : String(val("invoiceDueDays"))}
          onChange={(e) => void setFlag("invoiceDueDays", e.target.value === "" ? null : Number(e.target.value))}
          className="mt-1 h-9 w-48 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground"
        >
          <option value="0">Due on receipt</option>
          <option value="7">Net 7 days</option>
          <option value="14">Net 14 days</option>
          <option value="30">Net 30 days</option>
          <option value="60">Net 60 days</option>
          <option value="">No specific date</option>
        </select>
      </section>

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Time format</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Times show as 2:30 PM by default. Switch this on to show 14:30 instead on the crew app and the office screens.
        </p>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={val("use24HourTime") === true}
            onCheckedChange={(v) => void setFlag("use24HourTime", v === true)}
          />
          Show times in 24-hour format
        </label>
      </section>

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Day clock</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Lets {wt.workers} clock in and out for the day, with breaks. Off by default: they enter their hours on the week table instead.
          Timers on a {terms.job} are switched on for each {terms.job} separately.
        </p>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={val("dayClockEnabled") === true}
            onCheckedChange={(v) => void setFlag("dayClockEnabled", v === true)}
          />
          Allow clock in and clock out
        </label>
      </section>

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Setup guide</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A panel beside the page that lists the steps to get Field Services working. You can tuck it to the side or close it,
          and turn it back on here.
        </p>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={val("setupGuideEnabled") !== false}
            onCheckedChange={(v) => void setFlag("setupGuideEnabled", v === true)}
          />
          Show the setup guide
        </label>
      </section>
      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Wording</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Use your own word for a job, such as Project, Work order or Ticket. It changes tabs,
          buttons, the crew app and the messages and page your customers see.
        </p>
        <div className="mt-4 grid gap-4 sm:max-w-md sm:grid-cols-2">
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">One (singular)</Label>
            <Input value={word} maxLength={MAX_JOB_WORD_LENGTH} onChange={(e) => setWord(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Many (plural)</Label>
            <Input value={plural} maxLength={MAX_JOB_WORD_LENGTH} onChange={(e) => setPlural(e.target.value)} />
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:max-w-md sm:grid-cols-2">
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Person who does the work (one)</Label>
            <Input value={person} maxLength={MAX_JOB_WORD_LENGTH} onChange={(e) => setPerson(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Many (plural)</Label>
            <Input value={people} maxLength={MAX_JOB_WORD_LENGTH} onChange={(e) => setPeople(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">For example Worker, Staff, Technician or Crew member.</p>
        </div>
        <div className="mt-4 sm:max-w-xs">
          <Label className="mb-1 block text-xs font-medium text-muted-foreground">
            Name for the people tab (Labour)
          </Label>
          <Input value={labour} maxLength={MAX_JOB_WORD_LENGTH} onChange={(e) => setLabour(e.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">For example Crew, Staff or Team.</p>
        </div>
        <div className="mt-4 sm:max-w-xs">
          <Label className="mb-1 block text-xs font-medium text-muted-foreground">
            Name for the kind of time (Activity)
          </Label>
          <Input value={activity} maxLength={MAX_JOB_WORD_LENGTH} onChange={(e) => setActivity(e.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">
            Shown where crew pick Driving, Admin and so on. For example Work type or Task.
          </p>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Preview: &ldquo;New {word.trim() || DEFAULT_JOB_WORD}&rdquo; and &ldquo;{plural.trim() || DEFAULT_JOB_WORD_PLURAL}&rdquo;
          tab.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={saving !== null || !word.trim()}
            onClick={() =>
              void run(
                "words",
                { jobWord: word, jobWordPlural: plural, labourWord: labour, activityWord: activity, workerWord: person, workerWordPlural: people },
                "Wording saved.",
              )
            }
          >
            {spin("words")} Save wording
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving !== null}
            onClick={() => {
              setWord(DEFAULT_JOB_WORD);
              setPlural(DEFAULT_JOB_WORD_PLURAL);
              setLabour(DEFAULT_LABOUR_WORD);
              setActivity(DEFAULT_ACTIVITY_WORD);
              setPerson(DEFAULT_WORKER_WORD);
              setPeople(DEFAULT_WORKER_WORD_PLURAL);
              void run(
                "words",
                {
                  jobWord: DEFAULT_JOB_WORD,
                  jobWordPlural: DEFAULT_JOB_WORD_PLURAL,
                  labourWord: DEFAULT_LABOUR_WORD,
                  activityWord: DEFAULT_ACTIVITY_WORD,
                  workerWord: DEFAULT_WORKER_WORD,
                  workerWordPlural: DEFAULT_WORKER_WORD_PLURAL,
                },
                "Back to the standard wording.",
              );
            }}
          >
            Reset
          </Button>
        </div>
      </section>

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Message links and rules</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Which updates are sent, and what they say, is set for each service: open a service on the Services & areas tab and use Customer messages.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(
            [
              ["statusLinkInMessages", `Add a link to the customer's ${terms.job} page in those messages`],
              ["reviewRequestsEnabled", `Ask for a Google review when a ${terms.job} is completed (set up under Settings, Google reviews)`],
              ["reviewWaitsForPayment", "Ask for a review only after the invoice is paid"],
              ["timerStopOnComplete", "Stop the timer when a visit is completed"],
            ] as [keyof FieldServicesConfig, string][]
          ).map(([key, label]) => (
            <label key={key} className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={val(key) === true} onCheckedChange={(v) => void setFlag(key, v === true)} />
              {label}
            </label>
          ))}
        </div>
        <div className="mt-4 sm:max-w-sm">
          <Label className="mb-1 block text-xs font-medium text-muted-foreground">
            When crew have no phone alert on, tell them by
          </Label>
          <select
            value={(val("crewAlertChannel") as string | undefined) === "sms" ? "sms" : "email"}
            onChange={(e) => void setFlag("crewAlertChannel", e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring [&_option]:bg-background [&_option]:text-foreground"
          >
            <option value="email">Email</option>
            <option value="sms">Text first, then email</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Customers are emailed by default. Each service can switch a message to text first, text only or email only in its Customer messages.
          </p>
        </div>
      </section>

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Timesheets</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Rate cards for each role and a billing type on every {terms.job}. While this is off, invoices bill
          logged time at the single hourly rate you type when drafting them.
        </p>
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={val("timesheetsEnabled") === true}
            onCheckedChange={(v) => void setFlag("timesheetsEnabled", v === true)}
          />
          Turn on timesheets
        </label>
        {val("timesheetsEnabled") === true && (
          <div className="mt-4 sm:max-w-xs">
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              Billing type for new {terms.jobs}
            </Label>
            <BillingTypeSelect
              value={val("defaultBillingType")}
              onChange={(t) => void setFlag("defaultBillingType", t)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {billingTypeHints(terms)[val("defaultBillingType")]} Each {terms.job} can be changed until its first
              invoice. Set the sell and cost rate for each person in their staff details, or add rate cards on the Rate cards tab.
            </p>
          </div>
        )}
      </section>

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Timesheet limits</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          These apply to {wt.workers}. The office can still add or fix time for them.
          {config.timesheetsEnabled === true ? "" : " Timesheets are off, so they take effect once you turn them on in the Timesheets box above."}
        </p>
        <div className="mt-4 grid gap-4 sm:max-w-md sm:grid-cols-2">
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              Shortest entry (minutes)
            </Label>
            <Input
              inputMode="numeric"
              value={minMinutes}
              onChange={(e) => setMinMinutes(e.target.value.replace(/\D/g, "").slice(0, 3))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Shorter entries can&apos;t be saved, and a timer stopped sooner is dropped. 0 turns it off.
            </p>
          </div>
          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              Most hours in a day
            </Label>
            <Input
              inputMode="decimal"
              value={maxHours}
              onChange={(e) => setMaxHours(e.target.value.replace(/[^\d.]/g, "").slice(0, 5))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {withArticleCap(wt.worker)} can&apos;t log more than this on one day. Between 1 and 24.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          className="mt-4"
          disabled={saving !== null || minMinutes === "" || Number(maxHours) < 1}
          onClick={() =>
            void run(
              "limits",
              { minEntryMinutes: Number(minMinutes), maxDayHours: Number(maxHours) },
              "Limits saved.",
            )
          }
        >
          {spin("limits")} Save limits
        </Button>
      </section>

      <section className="rounded-2xl border bg-card p-6">
        <h2 className="text-base font-semibold">Timesheet button colours</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each colour has a light and a dark version, so the button and its text stay readable in
          both themes. Used for Submit week in the crew app and Unlock in the office.
        </p>
        <div className="mt-4 grid gap-6 sm:grid-cols-2">
          <ColorPicker label="Submit" value={submitColor} onChange={setSubmitColor} sample="Submit week" />
          <ColorPicker label="Unlock" value={unlockColor} onChange={setUnlockColor} sample="Unlock" />
        </div>
        <Button
          size="sm"
          className="mt-4"
          disabled={saving !== null}
          onClick={() =>
            void run(
              "colors",
              { submitButtonColor: submitColor, unlockButtonColor: unlockColor },
              "Colours saved.",
            )
          }
        >
          {spin("colors")} Save colours
        </Button>
      </section>

      <RouteSuggestionsCard />
    </div>
  );
}
