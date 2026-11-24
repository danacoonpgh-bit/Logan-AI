"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, ChevronRight, CreditCard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContactLine, PublicBrand, PublicCard, StatusPill } from "@/components/field-booking/public-frame";
import { Field, OtpInput } from "@/components/field-booking/public-fields";
import type { CustomerHome, PortalInvoice, PortalJob } from "@/lib/server/field-customer-portal-service";

type Stage = "loading" | "identify" | "code" | "home";

const RESEND_SECONDS = 60;

async function call<T>(url: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<{ status: number; data: T & { error?: string } }> {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as T & { error?: string } };
  } catch {
    return { status: 0, data: { error: "No connection. Check your signal and try again." } as T & { error?: string } };
  }
}

function when(v: NonNullable<PortalJob["nextVisit"]>): string {
  if (!v.startAt) return "To be confirmed";
  const d = new Date(v.startAt);
  const day = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: v.timezone });
  if (v.anytime) return `${day}, time to be confirmed`;
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: v.timezone })}`;
}

function money(currency: string, amount: number): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
}

function InvoiceCard({ invoice, paying, onPay }: { invoice: PortalInvoice; paying: boolean; onPay: (id: string) => void }) {
  const inv = invoice;
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium">Invoice {inv.number}</p>
          <p className="truncate text-xs text-muted-foreground">
            {inv.jobNumber ? `${inv.jobNumber} · ` : ""}
            {inv.paid ? `Paid ${shortDate(inv.paidAt)}`.trim() : shortDate(inv.sentAt)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-base font-semibold">{money(inv.currency, inv.total)}</p>
          <StatusPill tone={inv.paid ? "ok" : "warn"}>{inv.paid ? "Paid" : inv.dueLabel || "Unpaid"}</StatusPill>
        </div>
      </div>

      <details className="group mt-3">
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1 text-sm font-medium text-primary">
          <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" /> Details
        </summary>
        <div className="mt-2 space-y-2 text-sm">
          <ul className="divide-y rounded-lg border">
            {inv.lines.map((l, i) => (
              <li key={i} className="flex items-start justify-between gap-3 px-3 py-2">
                <span className="min-w-0">
                  {l.description}
                  {l.quantity !== 1 && (
                    <span className="block text-xs text-muted-foreground">
                      {l.quantity} x {money(inv.currency, l.unitPrice)}
                    </span>
                  )}
                </span>
                <span className="shrink-0">{money(inv.currency, l.total)}</span>
              </li>
            ))}
          </ul>
          <dl className="space-y-1 px-1 text-muted-foreground">
            {inv.discount > 0 && (
              <div className="flex justify-between">
                <dt>Discount</dt>
                <dd>-{money(inv.currency, inv.discount)}</dd>
              </div>
            )}
            {inv.tax > 0 && (
              <div className="flex justify-between">
                <dt>Tax{inv.taxPercent ? ` (${inv.taxPercent}%)` : ""}</dt>
                <dd>{money(inv.currency, inv.tax)}</dd>
              </div>
            )}
            <div className="flex justify-between font-medium text-foreground">
              <dt>Total</dt>
              <dd>{money(inv.currency, inv.total)}</dd>
            </div>
          </dl>
          {inv.notes && <p className="whitespace-pre-wrap px-1 text-xs text-muted-foreground">{inv.notes}</p>}
        </div>
      </details>

      {!inv.paid && (inv.canPayByCard || inv.payPalUrl) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {inv.canPayByCard && (
            <Button className="h-11 flex-1 text-base" disabled={paying} onClick={() => onPay(inv.id)}>
              {paying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />} Pay by card
            </Button>
          )}
          {inv.payPalUrl && (
            <Button variant="outline" className="h-11 flex-1 text-base" render={<a href={inv.payPalUrl} target="_blank" rel="noopener noreferrer" />}>
              Pay with PayPal
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-24 animate-pulse rounded-2xl bg-muted" />
      <div className="h-28 animate-pulse rounded-2xl bg-muted" />
      <div className="h-28 animate-pulse rounded-2xl bg-muted" />
    </div>
  );
}

function JobCard({ job }: { job: PortalJob }) {
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium">{job.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {job.number}
            {job.address ? ` · ${job.address}` : ""}
          </p>
        </div>
        <StatusPill tone={job.tone}>{job.status}</StatusPill>
      </div>
      {job.nextVisit && (
        <p className="mt-3 flex items-start gap-2 text-sm">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            {when(job.nextVisit)}
            {job.nextVisit.crew.length > 0 ? ` · ${job.nextVisit.crew.join(", ")}` : ""}
          </span>
        </p>
      )}
      {job.statusUrl && (
        <p className="mt-3 flex items-center gap-1 text-sm font-medium text-primary">
          Details and approvals <ChevronRight className="h-4 w-4" />
        </p>
      )}
    </>
  );
  return job.statusUrl ? (
    <a href={job.statusUrl} className="block rounded-2xl border bg-card p-4 shadow-sm transition-colors hover:bg-muted/40">
      {inner}
    </a>
  ) : (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">{inner}</div>
  );
}

export function CustomerPortal({
  subAccountId,
  businessName,
  logoUrl,
  bookingHref,
  contact,
}: {
  subAccountId: string;
  businessName: string;
  logoUrl: string | null;
  bookingHref: string | null;
  contact: { email: string | null; phone: string | null };
}) {
  const api = `/api/field-customer/${subAccountId}`;
  const [stage, setStage] = useState<Stage>("loading");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [home, setHome] = useState<CustomerHome | null>(null);
  const [wait, setWait] = useState(0);
  const [payingId, setPayingId] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const res = await call<CustomerHome>(`${api}/me`, "GET");
    if (res.status === 200) {
      setHome(res.data);
      setStage("home");
    } else {
      // A hiccup on a later look must not sign the customer out; only a real 401 or a first load does.
      setStage((cur) => (res.status === 401 || cur === "loading" ? "identify" : cur));
    }
  }, [api]);

  // Back from the card page can restore this screen with the spinner still on.
  useEffect(() => {
    const reset = () => setPayingId("");
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from the card page. The payment can take a moment to reach us, so look again a little later.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const paid = q.get("paid") === "1";
    if (!paid && q.get("cancelled") !== "1") return;
    window.history.replaceState(null, "", window.location.pathname);
    setNotice(paid ? "Thank you, your payment was received. It can take a moment to show as paid." : "Payment cancelled. You were not charged.");
    if (!paid) return;
    const timers = [4000, 12000].map((ms) => setTimeout(() => void load(), ms));
    return () => timers.forEach(clearTimeout);
  }, [load]);

  async function payInvoice(id: string) {
    if (payingId) return;
    setNotice("");
    setPayingId(id);
    const res = await call<{ url?: string }>(`${api}/invoices/${id}/pay`, "POST", {});
    if (res.status === 200 && res.data.url) {
      window.location.href = res.data.url;
      return;
    }
    setPayingId("");
    setNotice(res.data.error ?? "We could not start the payment. Please try again.");
    if (res.status === 401) setStage("identify");
  }

  // Counts down before the code can be sent again, matching the server's own wait.
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function sendCode() {
    setError("");
    if (!identifier.trim()) {
      setError("Enter your email address.");
      return;
    }
    setBusy(true);
    const res = await call<{ ok?: boolean }>(`${api}/request-code`, "POST", { identifier });
    setBusy(false);
    if (res.status !== 200) {
      setError(res.data.error ?? "Something went wrong. Please try again.");
      return;
    }
    setCode("");
    setWait(RESEND_SECONDS);
    setStage("code");
  }

  async function verify(value: string) {
    if (busy) return;
    setError("");
    setBusy(true);
    const res = await call<{ ok?: boolean }>(`${api}/verify`, "POST", { identifier, code: value });
    if (res.status !== 200) {
      setBusy(false);
      setCode("");
      setError(res.data.error ?? "That code isn't right.");
      return;
    }
    const me = await call<CustomerHome>(`${api}/me`, "GET");
    setBusy(false);
    setCode("");
    if (me.status === 200) {
      setHome(me.data);
      setStage("home");
    } else {
      setError("You're signed in, but we couldn't load your page. Please try again.");
      setStage("identify");
    }
  }

  async function signOut() {
    await call(`${api}/logout`, "POST", {});
    setHome(null);
    setIdentifier("");
    setStage("identify");
  }

  if (stage === "loading") {
    return (
      <div className="space-y-6">
        <PublicBrand name={businessName} logoUrl={logoUrl} />
        <Skeleton />
      </div>
    );
  }

  if (stage !== "home") {
    return (
      <div className="space-y-6">
        <PublicBrand name={businessName} logoUrl={logoUrl} />
        <PublicCard className="ls-step">
          <h1 className="text-lg font-semibold">{stage === "identify" ? "Sign in" : "Check your email"}</h1>
          {stage === "identify" ? (
            <form
              noValidate
              className="mt-1 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void sendCode();
              }}
            >
              <p className="text-sm text-muted-foreground">
                See your requests and bookings. We&apos;ll email a code to the address you gave us.
              </p>
              <Field
                label="Email address"
                type="email"
                value={identifier}
                autoComplete="email"
                maxLength={200}
                onChange={(e) => setIdentifier(e.target.value)}
              />
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="h-12 w-full text-base" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Send me a code
              </Button>
              {bookingHref && (
                <p className="text-center text-sm">
                  <a className="text-muted-foreground underline-offset-2 hover:underline" href={bookingHref}>
                    Book a service
                  </a>
                </p>
              )}
            </form>
          ) : (
            <form
              noValidate
              className="mt-1 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.length === 6) void verify(code);
              }}
            >
              <p className="text-sm text-muted-foreground">
                If we found <span className="font-medium text-foreground">{identifier}</span>, a 6-digit code is on its way. It can take a
                minute, so check your junk folder too.
              </p>
              <OtpInput value={code} onChange={setCode} onComplete={(v) => void verify(v)} disabled={busy} />
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="h-12 w-full text-base" disabled={busy || code.length !== 6}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Sign in
              </Button>
              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  className="min-h-11 text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setError("");
                    setCode("");
                    setStage("identify");
                  }}
                >
                  Use a different email
                </button>
                <button
                  type="button"
                  disabled={wait > 0 || busy}
                  className="min-h-11 font-medium text-primary underline-offset-2 hover:underline disabled:text-muted-foreground disabled:no-underline"
                  onClick={() => void sendCode()}
                >
                  {wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
                </button>
              </div>
            </form>
          )}
        </PublicCard>
        <ContactLine name={businessName} contact={contact} />
      </div>
    );
  }

  const data = home as CustomerHome;
  const active = data.jobs.filter((j) => !j.past);
  const past = data.jobs.filter((j) => j.past);
  const unpaid = data.invoices.filter((i) => !i.paid);
  const paidInvoices = data.invoices.filter((i) => i.paid);
  // The visit that comes first across everything still going.
  const upNext = active
    .filter((j) => j.nextVisit?.startAt)
    .sort((a, b) => (a.nextVisit?.startAt ?? "").localeCompare(b.nextVisit?.startAt ?? ""))[0];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <PublicBrand name={businessName} logoUrl={logoUrl} subtitle={`Hi ${data.name.split(/\s+/)[0] || "there"}`} />
        <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>

      {notice && (
        <p role="status" className="rounded-2xl border bg-card p-4 text-sm shadow-sm">
          {notice}
        </p>
      )}

      {unpaid.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Invoices to pay</h2>
          <ul className="space-y-3">
            {unpaid.map((i) => (
              <li key={i.id}>
                <InvoiceCard invoice={i} paying={payingId === i.id} onPay={(id) => void payInvoice(id)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {upNext?.nextVisit && (
        <PublicCard className="ls-step bg-primary/5 p-5 sm:p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-primary">Next up</p>
          <p className="mt-1 text-lg font-semibold">{when(upNext.nextVisit)}</p>
          <p className="text-sm text-muted-foreground">
            {upNext.title}
            {upNext.nextVisit.crew.length > 0 ? ` · ${upNext.nextVisit.crew.join(", ")}` : ""}
          </p>
        </PublicCard>
      )}

      {bookingHref && (
        <Button className="h-12 w-full text-base" render={<a href={bookingHref} />}>
          Book another service
        </Button>
      )}

      {data.requests.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Requests we&apos;re working on</h2>
          <ul className="space-y-2">
            {data.requests.map((r) => (
              <li key={r.number} className="rounded-2xl border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-medium">{r.title}</p>
                    <p className="text-xs text-muted-foreground">{r.number}</p>
                  </div>
                  <StatusPill tone="warn">We&apos;ll confirm a time</StatusPill>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Current {data.jobsWord.toLowerCase()}</h2>
        {active.length === 0 ? (
          <PublicCard className="text-center">
            <p className="text-sm text-muted-foreground">Nothing in progress right now.</p>
            {bookingHref && (
              <Button variant="outline" className="mt-3 h-11" render={<a href={bookingHref} />}>
                Book a service
              </Button>
            )}
          </PublicCard>
        ) : (
          <ul className="space-y-3">
            {active.map((j) => (
              <li key={j.number}>
                <JobCard job={j} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {past.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Past {data.jobsWord.toLowerCase()}</h2>
          <ul className="space-y-3">
            {past.map((j) => (
              <li key={j.number}>
                <JobCard job={j} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {paidInvoices.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Paid invoices</h2>
          <ul className="space-y-3">
            {paidInvoices.map((i) => (
              <li key={i.id}>
                <InvoiceCard invoice={i} paying={false} onPay={() => {}} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <ContactLine name={businessName} contact={contact} />
    </div>
  );
}
