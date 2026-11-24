"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContactLine, PublicBrand, StatusPill, type PublicTone } from "@/components/field-booking/public-frame";
import { formatMoneyCode } from "@/lib/field-services/money";
import { jobTerms } from "@/lib/field-services/terms";
import type { StatusPageData } from "@/lib/server/field-status-page-service";

const VISIT_LABEL: Record<string, string> = {
  pending: "Booked",
  on_my_way: "On the way",
  checked_in: "Here now",
  completed: "Done",
  no_show: "Missed",
  cancelled: "Cancelled",
};

const VISIT_TONE: Record<string, PublicTone> = {
  pending: "info",
  on_my_way: "warn",
  checked_in: "warn",
  completed: "ok",
  no_show: "muted",
  cancelled: "muted",
};

function when(iso: string | null, zone: string, anytime: boolean, locale: string): string {
  if (!iso) return "Time to be confirmed";
  const d = new Date(iso);
  try {
    const day = new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(d);
    if (anytime) return `${day}, any time`;
    const time = new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(d);
    return `${day}, ${time}`;
  } catch {
    return d.toISOString();
  }
}

function VisitChange({
  token,
  visit,
  refundNote,
  contact,
  onCancelled,
}: {
  token: string;
  visit: StatusPageData["visits"][number];
  refundNote: string;
  contact: StatusPageData["look"]["contact"];
  onCancelled: (id: string) => void;
}) {
  const [mode, setMode] = useState<"none" | "cancel" | "move">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<{ start: string; time: string }[] | null>(null);
  const base = `/api/j/${token}/visits/${visit.id}`;

  async function call(path: string, body: unknown) {
    const res = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; slots?: { start: string; time: string }[] };
    if (!res.ok) throw new Error(data.error ?? "That didn't work.");
    return data;
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No connection. Check your signal and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (visit.locked) {
    const how = [contact.phone, contact.email].filter(Boolean).join(" or ");
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        This visit is coming up soon, so it can&apos;t be changed online.{how ? ` To change it, contact us on ${how}.` : " Please contact us to change it."}
      </p>
    );
  }
  if (!visit.canCancel) return null;

  return (
    <div className="mt-3 space-y-3">
      {mode === "none" && (
        <div className="flex flex-wrap gap-2">
          {visit.canMove && (
            <Button variant="outline" className="h-11 touch-manipulation" onClick={() => setMode("move")}>
              Change time
            </Button>
          )}
          <Button variant="outline" className="h-11 touch-manipulation" onClick={() => setMode("cancel")}>
            Cancel visit
          </Button>
        </div>
      )}

      {mode === "cancel" && (
        <div className="space-y-2 rounded-xl border p-3">
          <p className="text-base">Cancel this visit?</p>
          {refundNote && <p className="text-sm text-muted-foreground">{refundNote}</p>}
          <div className="flex gap-2">
            <Button
              variant="destructive"
              className="h-11 touch-manipulation"
              disabled={busy}
              onClick={() => void run(async () => { await call("cancel", {}); onCancelled(visit.id); })}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Yes, cancel it
            </Button>
            <Button variant="outline" className="h-11" disabled={busy} onClick={() => setMode("none")}>
              Keep it
            </Button>
          </div>
        </div>
      )}

      {mode === "move" && (
        <div className="space-y-2 rounded-xl border p-3">
          <p className="text-base">Pick a new day</p>
          <Input
            type="date"
            className="h-12 text-base"
            value={date}
            min={new Date().toISOString().slice(0, 10)}
            aria-label="New day"
            onChange={(e) => {
              const d = e.target.value;
              setDate(d);
              setSlots(null);
              if (d) void run(async () => setSlots((await call("slots", { date: d })).slots ?? []));
            }}
          />
          {busy && !slots && <p className="text-sm text-muted-foreground">Looking for times…</p>}
          {slots && slots.length === 0 && <p className="text-sm text-muted-foreground">No times are free that day. Try another.</p>}
          {slots && slots.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {slots.map((sl) => (
                <Button
                  key={sl.start}
                  variant="outline"
                  className="h-11 touch-manipulation"
                  disabled={busy}
                  onClick={() => void run(async () => { await call("move", { slot: sl.start }); window.location.reload(); })}
                >
                  {sl.time}
                </Button>
              ))}
            </div>
          )}
          <Button variant="outline" className="h-11" disabled={busy} onClick={() => setMode("none")}>
            Back
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function ApprovalCard({
  token,
  approval,
  onDone,
}: {
  token: string;
  approval: StatusPageData["approvals"][number];
  onDone: (id: string, status: "approved" | "declined") => void;
}) {
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState("");

  async function answer(decision: "approve" | "decline") {
    setBusy(decision);
    setError("");
    try {
      const res = await fetch(`/api/j/${token}/approvals/${approval.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, name, comment }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't work.");
        return;
      }
      onDone(approval.id, decision === "approve" ? "approved" : "declined");
    } catch {
      setError("No connection. Check your signal and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm">
      <h3 className="text-lg font-semibold">Extra work to approve</h3>
      {approval.note && <p className="text-base text-muted-foreground">{approval.note}</p>}
      <ul className="divide-y rounded-xl border text-base">
        {approval.lines.map((l, i) => (
          <li key={i} className="flex items-start justify-between gap-3 p-3">
            <span>
              {l.description}
              {l.quantity !== 1 ? ` × ${l.quantity}` : ""}
            </span>
            <span className="shrink-0 font-medium">
              {formatMoneyCode(approval.currency, Math.round(l.quantity * l.unitPriceMinor))}
            </span>
          </li>
        ))}
        <li className="flex justify-between gap-3 p-3 text-lg font-semibold">
          <span>Total</span>
          <span>{formatMoneyCode(approval.currency, approval.totalMinor)}</span>
        </li>
      </ul>
      <Input
        className="h-14 text-base"
        placeholder="Your full name (to approve)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoComplete="name"
        aria-label="Your full name"
      />
      <Input
        className="h-14 text-base"
        placeholder="Anything you want to add (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={500}
        aria-label="Comment"
      />
      {error && (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Button
          className="h-14 touch-manipulation text-base"
          disabled={busy !== null || name.trim().length < 2}
          onClick={() => void answer("approve")}
        >
          {busy === "approve" && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
          Approve
        </Button>
        <Button
          variant="outline"
          className="h-14 touch-manipulation text-base"
          disabled={busy !== null}
          onClick={() => void answer("decline")}
        >
          {busy === "decline" && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
          Decline
        </Button>
      </div>
    </section>
  );
}

function SignoffCard({
  token,
  signoff,
  business,
  zone,
  locale,
  onDone,
}: {
  token: string;
  signoff: StatusPageData["signoffs"][number];
  business: string;
  zone: string;
  locale: string;
  onDone: (id: string, name: string) => void;
}) {
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/j/${token}/signoffs/${signoff.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, comment }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't work.");
        return;
      }
      onDone(signoff.id, name.trim());
    } catch {
      setError("No connection. Check your signal and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm">
      <h3 className="text-lg font-semibold">Please confirm the work</h3>
      <p className="text-base text-muted-foreground">
        {business} {signoff.tech ? `(${signoff.tech}) ` : ""}finished work on {when(signoff.start, zone, signoff.anytime, locale)}.
      </p>
      {signoff.checklist.length > 0 && (
        <ul className="divide-y rounded-xl border text-base">
          {signoff.checklist.map((i, n) => (
            <li key={n} className="flex items-start gap-3 p-3">
              <span aria-hidden className="mt-0.5 w-5 shrink-0 text-center">
                {i.done ? "\u2713" : "\u2013"}
              </span>
              <span className={i.done ? "" : "text-muted-foreground"}>
                {i.text}
                {i.done ? "" : " (not done)"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Input
        className="h-14 text-base"
        placeholder="Your full name (to confirm)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoComplete="name"
        aria-label="Your full name"
      />
      <Input
        className="h-14 text-base"
        placeholder="Anything you want to add (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={500}
        aria-label="Comment"
      />
      <p className="text-sm text-muted-foreground">
        Typing your name confirms the work above is complete. If something isn&apos;t right, contact {business} instead.
      </p>
      {error && (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      )}
      <Button
        className="h-14 w-full touch-manipulation text-base"
        disabled={busy || name.trim().length < 2}
        onClick={() => void confirm()}
      >
        {busy && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
        Confirm the work is complete
      </Button>
    </section>
  );
}

export function CustomerStatus({ token, data }: { token: string; data: StatusPageData }) {
  const [approvals, setApprovals] = useState(data.approvals);
  const [signoffs, setSignoffs] = useState(data.signoffs);
  const [visits, setVisits] = useState(data.visits);
  const [locale, setLocale] = useState("en");
  useEffect(() => {
    setLocale(navigator.language || "en");
  }, []);
  const terms = jobTerms({ jobWord: data.jobWord, jobWordPlural: data.jobWordPlural });
  const finished = data.job.closed || data.job.cancelled;
  const pending = finished ? [] : approvals.filter((a) => a.status === "pending");
  const askedToSign = finished ? [] : signoffs.filter((x) => x.status === "pending");
  const signed = signoffs.filter((x) => x.status === "signed");
  const answered = approvals.filter((a) => a.status !== "pending");

  return (
    <main className="space-y-6">
      <PublicBrand name={data.business} logoUrl={data.look.logoUrl} />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{data.job.title}</h1>
        {data.job.address && <p className="text-base text-muted-foreground">{data.job.address}</p>}
        <p className="text-sm text-muted-foreground">{terms.Job} {data.job.number}</p>
        {data.job.repeats && <p className="text-base">Repeats: {data.job.repeats}</p>}
      </header>

      {data.job.closed && (
        <p className="rounded-xl border p-3 text-base text-muted-foreground">
          This {terms.job} is finished. Thank you for choosing {data.business}.
        </p>
      )}
      {data.job.cancelled && (
        <p className="rounded-xl border p-3 text-base text-muted-foreground">
          This {terms.job} was cancelled. Contact {data.business} if you have questions.
        </p>
      )}

      {askedToSign.map((x) => (
        <SignoffCard
          key={x.id}
          token={token}
          signoff={x}
          business={data.business}
          zone={data.job.timezone}
          locale={locale}
          onDone={(id, name) =>
            setSignoffs((list) => list.map((y) => (y.id === id ? { ...y, status: "signed", signedBy: name } : y)))
          }
        />
      ))}

      {pending.map((a) => (
        <ApprovalCard
          key={a.id}
          token={token}
          approval={a}
          onDone={(id, status) =>
            setApprovals((list) => list.map((x) => (x.id === id ? { ...x, status } : x)))
          }
        />
      ))}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Visits</h2>
        {visits.length === 0 ? (
          <p className="text-base text-muted-foreground">No visit is booked yet. We will message you when it is.</p>
        ) : (
          <ul className="space-y-2">
            {visits.map((v) => (
              <li key={v.id} className="rounded-xl border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-base font-medium">{when(v.start, data.job.timezone, v.anytime, locale)}</p>
                  <StatusPill tone={VISIT_TONE[v.status] ?? "info"}>{VISIT_LABEL[v.status] ?? v.status}</StatusPill>
                </div>
                {v.tech && <p className="mt-1 text-base text-muted-foreground">{v.tech}</p>}
                <VisitChange
                  token={token}
                  visit={v}
                  refundNote={data.refundNote}
                  contact={data.look.contact}
                  onCancelled={(id) => setVisits((list) => list.map((x) => (x.id === id ? { ...x, status: "cancelled", canCancel: false, canMove: false } : x)))}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {signed.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Confirmed work</h2>
          <ul className="space-y-2">
            {signed.map((x) => (
              <li key={x.id} className="rounded-xl border bg-card p-4 text-base">
                {when(x.start, data.job.timezone, x.anytime, locale)} · Confirmed by {x.signedBy || "you"}
              </li>
            ))}
          </ul>
        </section>
      )}

      {answered.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Extra work</h2>
          <ul className="space-y-2">
            {answered.map((a) => (
              <li key={a.id} className="rounded-xl border bg-card p-4 text-base">
                {formatMoneyCode(a.currency, a.totalMinor)} ·{" "}
                {a.status === "approved" ? "You approved this" : "You declined this"}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(data.look.portalHref || data.look.bookingHref) && (
        <nav aria-label="More" className="flex flex-col gap-2">
          {data.look.portalHref && (
            <Button variant="outline" className="h-12 text-base" render={<a href={data.look.portalHref} />}>
              See all your requests
            </Button>
          )}
          {data.look.bookingHref && (
            <Button variant="outline" className="h-12 text-base" render={<a href={data.look.bookingHref} />}>
              Book another service
            </Button>
          )}
        </nav>
      )}
      <ContactLine name={data.business} contact={data.look.contact} />
    </main>
  );
}
