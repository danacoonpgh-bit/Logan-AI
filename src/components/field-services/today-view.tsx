"use client";

import { PROJECT_KIND_LABELS, PROJECT_KIND_STYLE } from "@/lib/field-services/project-kind";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  CalendarCheck,
  Camera,
  Clock,
  Loader2,
  MapPin,
  MessageCircle,
  MessageSquare,
  Navigation,
  Phone,
  Play,
  RefreshCw,
  Square,
  UserRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldSelect } from "@/components/field-booking/public-fields";
import { VisitStatusPill, callApi } from "@/components/field-services/field-ui";
import { JobNotes } from "@/components/field-services/job-notes";
import { addDaysToKey, applyClock24, clockHourCycle, formatInZone, zonedDateKey } from "@/lib/field-services/time";
import { jobTerms } from "@/lib/field-services/terms";
import { formatMinor, formatMoneyCode, parseDecimalInput, unitToMinor } from "@/lib/field-services/money";
import { useAuth } from "@/hooks/use-auth";
import { preparePhoto } from "@/lib/field-services/image-client";
import { flushQueue, uploadOrQueue } from "@/lib/field-services/photo-upload";
import { listQueued, markFailed, removeQueued } from "@/lib/field-services/photo-queue";
import type { TodayVisit } from "@/lib/server/field-today-service";
import type { PhotoLabel } from "@/types/field-services";

const POLL_MS = 30_000;
const ARM_MS = 4_000;
const ACTION_LINK =
  "flex h-12 touch-manipulation items-center justify-center gap-1.5 rounded-lg border text-sm font-medium active:bg-muted";
const TEXT_ACTION = "min-h-11 touch-manipulation px-2 text-sm underline";
const LABELS: { id: PhotoLabel; label: string }[] = [
  { id: "before", label: "Before" },
  { id: "after", label: "After" },
  { id: "issue", label: "Issue" },
  { id: "receipt", label: "Receipt" },
  { id: "other", label: "Other" },
];
const METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  cheque: "Cheque",
  terminal: "Card terminal",
  other: "Other",
};
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Waiting for the office",
  confirmed: "Confirmed",
  rejected: "Not accepted",
};
const METHOD_OPTIONS: [string, string][] = [
  ["cash", "Cash"],
  ["cheque", "Cheque"],
  ["terminal", "Card terminal"],
  ["other", "Other"],
];

function visitRank(status: string): number {
  if (status === "on_my_way" || status === "checked_in") return 0;
  if (status === "completed" || status === "no_show" || status === "cancelled") return 2;
  return 1;
}

function formatElapsed(startIso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - new Date(startIso).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Owns its own interval so the rest of the screen does not re-render every second.
function Elapsed({ startAt }: { startAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{formatElapsed(startAt, now)}</>;
}

function Skeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading your day">
      <div className="h-40 animate-pulse rounded-2xl bg-muted" />
      <div className="h-40 animate-pulse rounded-2xl bg-muted" />
    </div>
  );
}

/** True from the desktop breakpoint up. Starts false so the phone layout is what first paints. */
function useWideScreen(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide;
}

/** One visit as a line, for a list on a big screen. Opening it shows the full card. */
/** The faint colour and label for a project's billing type; empty when the workspace has none. */
function kindLook(v: TodayVisit): { edge: string; chip: string; label: string } | null {
  if (!v.job.kind) return null;
  const st = PROJECT_KIND_STYLE[v.job.kind];
  return { edge: "border-l-4 " + st.edge + " " + st.tint, chip: st.chip, label: PROJECT_KIND_LABELS[v.job.kind] };
}

function KindChip({ v }: { v: TodayVisit }) {
  const k = kindLook(v);
  if (!k) return null;
  return <span className={"inline-block rounded-full px-2 py-0.5 text-[10px] font-medium " + k.chip}>{k.label}</span>;
}

function VisitRow({ v, onOpen, compact = false }: { v: TodayVisit; onOpen: () => void; compact?: boolean }) {
  applyClock24(v.clock24);
  const start = v.visit.scheduledStart ? new Date(v.visit.scheduledStart) : null;
  const active = v.visit.status === "on_my_way" || v.visit.status === "checked_in";
  const look = kindLook(v);
  if (compact) {
    const when = start
      ? `${formatInZone(start, v.job.timezone, { weekday: "short", day: "numeric", month: "short" })}, ${
          v.visit.anytime ? "any time" : formatInZone(start, v.job.timezone, { hour: "numeric", minute: "2-digit" })
        }`
      : "";
    return (
      <button
        type="button"
        onClick={onOpen}
        className={`flex w-full touch-manipulation items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left shadow-sm active:bg-muted/50 ${look?.edge ?? ""} ${active ? "ring-2 ring-primary/40" : ""}`}
      >
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block truncate text-base font-semibold">{v.job.title}</span>
          <KindChip v={v} />
          <span className="block truncate text-sm text-muted-foreground">{when}</span>
          <span className="block truncate text-sm text-muted-foreground">Customer: {v.customer.name}</span>
          {v.job.address && <span className="block truncate text-sm text-muted-foreground">{v.job.address}</span>}
        </span>
        <VisitStatusPill status={v.visit.status} />
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`grid w-full grid-cols-[9rem_minmax(0,1.2fr)_minmax(0,1.4fr)_auto_1.5rem] items-center gap-4 rounded-xl border bg-card px-4 py-3 text-left shadow-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${look?.edge ?? ""} ${active ? "ring-2 ring-primary/40" : ""}`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">
          {start ? formatInZone(start, v.job.timezone, { weekday: "short", day: "numeric", month: "short" }) : "—"}
        </span>
        <span className="block text-sm text-muted-foreground">
          {v.visit.anytime
            ? "Any time"
            : start
              ? formatInZone(start, v.job.timezone, { hour: "numeric", minute: "2-digit" })
              : ""}
        </span>
      </span>
      <span className="min-w-0">
        <span className="block truncate text-base font-semibold">
          {v.job.title} <KindChip v={v} />
        </span>
        <span className="block truncate text-sm text-muted-foreground">
          Customer: {v.customer.name}
          {v.job.number ? ` · ${v.job.number}` : ""}
        </span>
      </span>
      <span className="block min-w-0 truncate text-sm text-muted-foreground">{v.job.address || "No address"}</span>
      <VisitStatusPill status={v.visit.status} />
      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
    </button>
  );
}

export function TodayView({
  endpoint,
  portal = false,
  onSummary,
  onSeeRoute,
}: {
  endpoint: string;
  portal?: boolean;
  /** Told how many of today's visits there are and how many are finished, and the next day with visits. */
  onSummary?: (summary: { assigned: number; completed: number; nextDay: string | null }) => void;
  /** Shows a Route link on each coming day, which opens that day's route. */
  onSeeRoute?: (day: string) => void;
}) {
  const { user } = useAuth();
  const [viewerId, setViewerId] = useState("");
  const uid = portal ? viewerId : (user?.uid ?? "");
  const wide = useWideScreen();
  const [openVisit, setOpenVisit] = useState<string | null>(null);
  const [visits, setVisits] = useState<TodayVisit[] | null>(null);
  const [error, setError] = useState(false);
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState(0);
  const [stuck, setStuck] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const lastLoad = useRef(0);
  applyClock24(visits?.[0]?.clock24);

  const load = useCallback(async () => {
    lastLoad.current = Date.now();
    try {
      const res = await fetch(endpoint, { cache: "no-store" });
      if (res.status === 401 && portal) {
        window.location.replace(`/field/${window.location.pathname.split("/")[2] ?? ""}/login`);
        return;
      }
      if (!res.ok) throw new Error("bad status");
      const data = (await res.json()) as { visits: TodayVisit[]; viewerId?: string };
      if (data.viewerId) setViewerId(data.viewerId);
      setVisits(data.visits);
      setUpdatedAt(Date.now());
      setError(false);
    } catch {
      setError(true);
    }
  }, [endpoint, portal]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const refreshQueue = useCallback(async () => {
    const all = await listQueued();
    setQueued(all.filter((q) => !q.lastError).length);
    setStuck(all.filter((q) => q.lastError && q.uid === uid).length);
  }, [uid]);

  useEffect(() => {
    void load();
    void refreshQueue();
    setOnline(navigator.onLine);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    // Focus and visibility fire together on most phones, so skip a second load right after the first.
    const onBack = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastLoad.current < 2000) return;
      void load();
      void refreshQueue();
    };
    const onOnline = async () => {
      setOnline(true);
      if (!uid) return;
      if ((await flushQueue(uid)) > 0) toast.success("Waiting photos uploaded.");
      void refreshQueue();
      void load();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    void onOnline();
    return () => {
      clearInterval(poll);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [load, refreshQueue, uid]);

  async function retryStuck() {
    const rows = (await listQueued()).filter((q) => q.lastError && q.uid === uid);
    // An empty error message counts as not failed, so the next flush picks the photo up again.
    for (const q of rows) await markFailed(q.id, "");
    let sent = await flushQueue(uid);
    // A flush already running returns at once, so try again shortly.
    if (sent === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      sent = await flushQueue(uid);
    }
    if (sent > 0) toast.success("Waiting photos uploaded.");
    await refreshQueue();
  }

  async function discardStuck() {
    const rows = (await listQueued()).filter((q) => q.lastError && q.uid === uid);
    for (const q of rows) await removeQueued(q.id);
    await refreshQueue();
  }

  useEffect(() => {
    if (!visits || !onSummary) return;
    const now = new Date();
    const today = visits.filter(
      (v) =>
        v.visit.status !== "cancelled" &&
        zonedDateKey(v.visit.scheduledStart ? new Date(v.visit.scheduledStart) : now, v.job.timezone) ===
          zonedDateKey(now, v.job.timezone),
    );
    // Each project has its own time zone, so a day is worked out per visit.
    const ahead = visits
      .filter((v) => v.visit.status !== "cancelled" && v.visit.scheduledStart)
      .map((v) => ({ day: zonedDateKey(new Date(v.visit.scheduledStart as string), v.job.timezone), today: zonedDateKey(now, v.job.timezone) }))
      .filter((d) => d.day > d.today && d.day <= addDaysToKey(d.today, 7))
      .map((d) => d.day)
      .sort();
    onSummary({
      assigned: today.length,
      completed: today.filter((v) => v.visit.status === "completed").length,
      nextDay: ahead[0] ?? null,
    });
  }, [visits, onSummary]);

  if (visits === null) {
    if (!error) return <Skeleton />;
    return (
      <p role="alert" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        Couldn&apos;t load your day.{" "}
        <button className={TEXT_ACTION} onClick={() => void load()}>
          Try again
        </button>
      </p>
    );
  }

  const sorted = [...visits].sort((a, b) => visitRank(a.visit.status) - visitRank(b.visit.status));
  // Today first, then what is coming up, then anything from the last couple of days.
  const nowDate = new Date();
  const dayOf = (v: TodayVisit) => zonedDateKey(v.visit.scheduledStart ? new Date(v.visit.scheduledStart) : nowDate, v.job.timezone);
  const todayOf = (v: TodayVisit) => zonedDateKey(nowDate, v.job.timezone);
  const byStart = (a: TodayVisit, b: TodayVisit) => (a.visit.scheduledStart ?? "").localeCompare(b.visit.scheduledStart ?? "");
  const todays = sorted.filter((v) => dayOf(v) === todayOf(v));
  const upcoming = visits.filter((v) => dayOf(v) > todayOf(v)).sort(byStart);
  const earlier = visits.filter((v) => dayOf(v) < todayOf(v)).sort(byStart);

  return (
    <div className="space-y-4">
      {(error || !online) && (
        <p
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400"
        >
          No connection. What you see may be out of date, and status and timer taps need a signal.
        </p>
      )}
      {queued > 0 && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {queued} photo{queued === 1 ? "" : "s"} waiting to upload. They send automatically when you have signal.
        </p>
      )}
      {stuck > 0 && (
        <div role="status" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p>
            {stuck} photo{stuck === 1 ? "" : "s"} couldn&apos;t upload.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 touch-manipulation" onClick={() => void retryStuck()}>
              Retry
            </Button>
            <Button variant="outline" className="h-11 touch-manipulation" onClick={() => void discardStuck()}>
              Discard
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-end gap-1 text-sm text-muted-foreground">
        {updatedAt && (
          <span>
            Updated {new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: clockHourCycle() })}
          </span>
        )}
        <button
          type="button"
          aria-label="Refresh"
          disabled={refreshing}
          onClick={() => void refresh()}
          className="flex h-11 w-11 touch-manipulation items-center justify-center rounded-lg active:bg-muted"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>
      {sorted.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-card p-6 text-center shadow-sm">
          <CalendarCheck className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Nothing scheduled for you around today.</p>
          <Button variant="outline" className="h-12 touch-manipulation" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Check again
          </Button>
        </div>
      ) : (
        <>
          <section aria-label="Today" className="space-y-2">
            <h2 className="text-base font-semibold">Today</h2>
            {todays.length === 0 ? (
              <p className="rounded-xl border p-4 text-sm text-muted-foreground">Nothing scheduled for today.</p>
            ) : portal ? (
              <ul className="space-y-2">
                {todays.map((v) => (
                  <li key={v.visit.id}>
                    <VisitRow v={v} compact={!wide} onOpen={() => setOpenVisit(v.visit.id)} />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="space-y-4">
                {todays.map((v) => (
                  <VisitCard key={v.visit.id} v={v} reload={load} onQueued={refreshQueue} uid={uid} portal={portal} />
                ))}
              </div>
            )}
          </section>
          {upcoming.length > 0 && (
            <section aria-label="Coming up" className="space-y-2">
              <h2 className="text-base font-semibold">Coming up</h2>
              {(onSeeRoute ? [...new Set(upcoming.map(dayOf))] : [""]).map((day) => (
                <div key={day} className="space-y-2">
                  {onSeeRoute && (
                    <div className="flex items-center justify-between gap-3 pt-1">
                      <h3 className="text-sm font-medium text-muted-foreground">
                        {formatInZone(new Date(`${day}T12:00:00Z`), "UTC", { weekday: "long", day: "numeric", month: "short" })}
                      </h3>
                      <button className={TEXT_ACTION} onClick={() => onSeeRoute(day)}>
                        See route
                      </button>
                    </div>
                  )}
                  <ul className="space-y-2">
                    {upcoming
                      .filter((v) => !onSeeRoute || dayOf(v) === day)
                      .map((v) => (
                        <li key={v.visit.id}>
                          <VisitRow v={v} compact={!wide} onOpen={() => setOpenVisit(v.visit.id)} />
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </section>
          )}
          {earlier.length > 0 && (
            <section aria-label="Earlier" className="space-y-2">
              <h2 className="text-base font-semibold text-muted-foreground">Earlier</h2>
              <ul className="space-y-2">
                {earlier.map((v) => (
                  <li key={v.visit.id}>
                    <VisitRow v={v} compact={!wide} onOpen={() => setOpenVisit(v.visit.id)} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Dialog open={openVisit !== null} onOpenChange={(o) => !o && setOpenVisit(null)}>
            <DialogContent
              showCloseButton={false}
              className="top-0 left-0 h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 grid-cols-1 content-start gap-2 overflow-x-hidden overflow-y-auto rounded-none px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[90dvh] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:pt-4"
            >
              <DialogHeader className="sticky top-0 z-10 -mx-4 flex-row items-center justify-between bg-background px-4 pb-1">
                <DialogTitle className="text-base font-semibold">Visit</DialogTitle>
                <DialogDescription className="sr-only">Everything for this visit.</DialogDescription>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 w-11 touch-manipulation p-0"
                  aria-label="Close"
                  onClick={() => setOpenVisit(null)}
                >
                  <X className="h-6 w-6" />
                </Button>
              </DialogHeader>
              {visits
                .filter((v) => v.visit.id === openVisit)
                .map((v) => (
                  <VisitCard key={v.visit.id} v={v} reload={load} onQueued={refreshQueue} uid={uid} portal={portal} />
                ))}
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

function VisitCard({
  v,
  reload,
  onQueued,
  uid,
  portal,
}: {
  v: TodayVisit;
  reload: () => Promise<void>;
  onQueued: () => Promise<void>;
  uid: string;
  portal: boolean;
}) {
  applyClock24(v.clock24);
  const terms = jobTerms({ jobWord: v.jobWord, jobWordPlural: v.jobWordPlural });
  const [armed, setArmed] = useState<string | null>(null);
  const base = portal
    ? `/api/field-portal/${v.subAccountId}`
    : `/api/sub-accounts/${v.subAccountId}/field-services`;
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<"parts" | "payment" | "pricing" | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const finished = ["completed", "no_show", "cancelled"].includes(v.visit.status);
  const active = v.visit.status === "on_my_way" || v.visit.status === "checked_in";
  const start = v.visit.scheduledStart ? new Date(v.visit.scheduledStart) : null;

  // A forgotten first tap must not leave a dangerous action one tap from firing.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() =>
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
    return () => cancelAnimationFrame(id);
  }, [open]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    await fn();
    setBusy(null);
    // The Time section shows the same timers, so let it refresh now.
    window.dispatchEvent(new Event("field-time-changed"));
    await reload();
  }

  const setStatus = (status: string) =>
    act(status, () => callApi(`${base}/visits/${v.visit.id}/status`, "POST", { status }));

  const mapsUrl = v.job.address
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v.job.address)}`
    : null;
  // WhatsApp needs the number with its country code; stored numbers are saved that way.
  const whatsappDigits = (() => {
    const phone = v.customer.phone ?? "";
    const digits = phone.replace(/[^0-9]/g, "");
    return phone.trim().startsWith("+") && digits.length >= 8 ? digits : null;
  })();

  const itemsLeft = v.visit.checklist.filter((i) => i.required && !i.done).length;
  const completeHint =
    v.visit.requireChecklist && itemsLeft > 0
      ? `Finish the checklist first. ${itemsLeft} required item${itemsLeft === 1 ? "" : "s"} left.`
      : v.visit.requireSignature && v.visit.signoff.status !== "signed"
        ? "The customer needs to sign off before you can complete this visit."
        : null;

  const primary =
    v.visit.status === "pending"
      ? { status: "on_my_way", label: "On my way" }
      : v.visit.status === "on_my_way"
        ? { status: "checked_in", label: "I've arrived" }
        : v.visit.status === "checked_in"
          ? { status: "completed", label: "Complete the visit" }
          : null;

  const completing = primary?.status === "completed";

  const primaryButton =
    primary && !finished ? (
      <Button
        className="h-14 w-full touch-manipulation text-base"
        disabled={busy !== null}
        onClick={() => {
          if (primary.status === "completed" && armed !== "completed") {
            setArmed("completed");
            return;
          }
          setArmed(null);
          void setStatus(primary.status);
        }}
      >
        {busy === primary.status && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {armed === primary.status ? "Tap again to complete" : primary.label}
      </Button>
    ) : null;

  return (
    <article
      className={`space-y-4 rounded-2xl bg-card p-4 shadow-sm ${kindLook(v)?.edge ?? ""} ${active ? "ring-2 ring-primary/40" : ""}`}
    >
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold leading-tight">{v.job.title}</h2>
          <VisitStatusPill status={v.visit.status} />
        </div>
        <KindChip v={v} />
        <p className="flex items-center gap-1.5 text-base font-medium text-foreground">
          <Clock className="h-4 w-4" />
          {start
            ? formatInZone(start, v.job.timezone, {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "numeric",
                minute: "2-digit",
              })
            : "—"}
          {v.visit.anytime ? " (any time that day)" : ""}
        </p>
        <p className="flex items-center gap-1.5 text-base font-medium">
          <UserRound className="h-4 w-4 shrink-0" aria-hidden="true" /> Customer: {v.customer.name}
        </p>
        {v.job.address && (
          <p className="flex items-start gap-1.5 text-base text-foreground">
            <MapPin className="mt-1 h-4 w-4 shrink-0" /> {v.job.address}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {v.job.number}
          {v.subAccountName ? ` · ${v.subAccountName}` : ""}
        </p>
      </header>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2">
        {mapsUrl ? (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noreferrer"
            className={ACTION_LINK}
          >
            <Navigation className="h-4 w-4" /> Navigate
          </a>
        ) : null}
        {v.customer.phone ? (
          <>
            <a
              href={`tel:${v.customer.phone}`}
              className={ACTION_LINK}
            >
              <Phone className="h-4 w-4" /> Call
            </a>
            <a
              href={`sms:${v.customer.phone}`}
              className={ACTION_LINK}
            >
              <MessageSquare className="h-4 w-4" /> Text
            </a>
            {whatsappDigits && (
              <a
                href={`https://wa.me/${whatsappDigits}`}
                target="_blank"
                rel="noreferrer"
                className={ACTION_LINK}
              >
                <MessageCircle className="h-4 w-4" /> WhatsApp
              </a>
            )}
          </>
        ) : null}
      </div>

      {v.visit.notes && (
        <p className="rounded-xl bg-muted/50 p-3 text-sm">{v.visit.notes}</p>
      )}

      {v.job.description && (
        <p className="whitespace-pre-wrap rounded-xl bg-muted/50 p-3 text-sm">{v.job.description}</p>
      )}

      <JobNotes
        notes={(v.job.notes ?? []).map((n) => ({ ...n, canEdit: n.mine }))}
        onChange={async (change) => {
          const ok = await callApi(
            portal
              ? `${base}/visits/${v.visit.id}/job-notes`
              : `${base}/jobs/${v.job.id}/notes`,
            "POST",
            change,
          );
          if (ok) await reload();
          return !!ok;
        }}
      />

      {(!finished || v.timer) && (
        <div className="space-y-3">
          {!completing && primaryButton}

          {(v.job.timersEnabled || v.timer) && (
          <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
            <div>
              <p className="text-sm text-muted-foreground">Time on this {terms.job}</p>
              <p className="font-mono text-xl">
                {v.timer ? (v.timer.startAt ? <Elapsed startAt={v.timer.startAt} /> : "0:00:00") : "Not running"}
              </p>
            </div>
            {v.timer ? (
              <Button
                variant="outline"
                className="h-12 min-w-28 touch-manipulation"
                disabled={busy !== null}
                onClick={() =>
                  void act("stop", () =>
                    callApi(`${base}/visits/${v.visit.id}/timer`, "POST", {
                      action: "stop",
                      entryId: v.timer!.id,
                    }),
                  )
                }
              >
                <Square className="mr-1.5 h-4 w-4" /> Stop
              </Button>
            ) : (
              <Button
                className="h-12 min-w-28 touch-manipulation"
                disabled={busy !== null}
                onClick={() =>
                  void act("start", () =>
                    callApi(`${base}/visits/${v.visit.id}/timer`, "POST", { action: "start" }),
                  )
                }
              >
                <Play className="mr-1.5 h-4 w-4" /> Start
              </Button>
            )}
          </div>
          )}
        </div>
      )}

      <ChecklistSection v={v} base={base} reload={reload} finished={finished} />

      <PhotoSection
        v={v}
        disabled={finished && v.job.status === "closed"}
        reload={reload}
        onQueued={onQueued}
        uid={uid}
        base={base}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="h-12 touch-manipulation"
          aria-expanded={open === "parts"}
          onClick={() => setOpen(open === "parts" ? null : "parts")}
        >
          Parts ({v.materials.length})
        </Button>
        {v.perms.prices && v.job.pricing && (
          <Button
            variant="outline"
            className="h-12 touch-manipulation"
            aria-expanded={open === "pricing"}
            onClick={() => setOpen(open === "pricing" ? null : "pricing")}
          >
            Pricing
          </Button>
        )}
        {v.perms.prices && (
          <Button
            variant="outline"
            className="h-12 touch-manipulation"
            aria-expanded={open === "payment"}
            onClick={() => setOpen(open === "payment" ? null : "payment")}
          >
            Collected on site{v.payments.length ? ` (${v.payments.length})` : ""}
          </Button>
        )}
        {!finished && v.visit.status !== "pending" && (
          <Button
            variant="outline"
            className="h-12 touch-manipulation"
            disabled={busy !== null}
            onClick={() => {
              if (armed !== "no_show") {
                setArmed("no_show");
                return;
              }
              setArmed(null);
              void setStatus("no_show");
            }}
          >
            {armed === "no_show" ? "Tap again to confirm" : "Customer not home"}
          </Button>
        )}
      </div>

      <div ref={panelRef}>
        {open === "parts" && <PartsSection v={v} base={base} reload={reload} />}
        {open === "pricing" && v.perms.prices && <PricingSection v={v} />}
        {open === "payment" && v.perms.prices && <PaymentSection v={v} base={base} reload={reload} />}
      </div>

      {completing && !finished && (
        <div className="space-y-3">
          {primaryButton}
          {completeHint && <p className="text-sm text-amber-700 dark:text-amber-400">{completeHint}</p>}
        </div>
      )}

      <TimeEntries v={v} base={base} reload={reload} />
    </article>
  );
}

function ChecklistSection({
  v,
  base,
  reload,
  finished,
}: {
  v: TodayVisit;
  base: string;
  reload: () => Promise<void>;
  finished: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const items = v.visit.checklist;
  const signoff = v.visit.signoff;
  const showSignoff = v.visit.requireSignature || signoff.status !== "none";
  if (items.length === 0 && !showSignoff) return null;

  const locked = finished || signoff.status === "signed";
  const left = items.filter((i) => i.required && !i.done).length;
  const arrived = v.visit.status === "checked_in" || v.visit.status === "completed";
  const checklistUrl = `${base}/visits/${v.visit.id}/checklist`;

  async function change(key: string, body: Record<string, unknown>) {
    setBusy(key);
    const res = await callApi(checklistUrl, "POST", body);
    setBusy(null);
    if (res) await reload();
    return res !== null;
  }

  async function ask() {
    setBusy("signoff");
    const res = await callApi<{ delivered: "sms" | "email" | null }>(
      `${base}/visits/${v.visit.id}/signoff`,
      "POST",
    );
    setBusy(null);
    if (!res) return;
    if (res.delivered) toast.success(`Sent to the customer by ${res.delivered === "sms" ? "text" : "email"}.`);
    else toast.error("Couldn't message the customer. Ask the office to complete this visit.");
    await reload();
  }

  return (
    <section className="space-y-3 rounded-xl border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-medium">Checklist</h3>
        {items.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {items.filter((i) => i.done).length} of {items.length} done
          </p>
        )}
      </div>
      {items.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {items.map((i) => (
            <li key={i.id} className="flex items-center">
              <label className="flex min-h-14 min-w-0 flex-1 touch-manipulation items-center gap-3 p-3">
                <input
                  type="checkbox"
                  checked={i.done}
                  disabled={locked || busy !== null}
                  onChange={(e) => void change(i.id, { action: "tick", itemId: i.id, done: e.target.checked })}
                  className="h-6 w-6 shrink-0 accent-primary"
                />
                <span className={`min-w-0 flex-1 text-base ${i.done ? "text-muted-foreground line-through" : ""}`}>
                  {i.text}
                  {i.required && !i.done && <span className="ml-2 text-xs text-muted-foreground">Required</span>}
                </span>
              </label>
              {i.source === "added" && !locked && (
                <button
                  className={TEXT_ACTION + " mr-1 min-w-11 shrink-0"}
                  disabled={busy !== null}
                  onClick={() => void change(i.id, { action: "remove", itemId: i.id })}
                >
                  {busy === i.id ? "Removing…" : "Remove"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!locked && (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field
              label="Add something to check"
              value={text}
              maxLength={120}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            className="h-12 touch-manipulation"
            disabled={busy !== null || !text.trim()}
            onClick={async () => {
              if (await change("add", { action: "add", text })) setText("");
            }}
          >
            Add
          </Button>
        </div>
      )}
      {v.visit.requireChecklist && left > 0 && !locked && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {left} required item{left === 1 ? "" : "s"} left before you can complete the visit.
        </p>
      )}

      {showSignoff && (
        <div className="space-y-2 rounded-xl bg-muted/40 p-3">
          <p className="text-sm font-medium">Customer sign-off</p>
          {signoff.status === "signed" ? (
            <p className="text-sm text-green-700 dark:text-green-400">
              Confirmed by {signoff.name || "the customer"}.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {signoff.status === "pending"
                  ? "Waiting for the customer to confirm. This page updates when they do."
                  : "The customer confirms the work by typing their name on a link we send them."}
              </p>
              {!arrived && (
                <p className="text-sm text-muted-foreground">Mark that you have arrived first.</p>
              )}
              {!finished || v.job.status !== "closed" ? (
                <Button
                  variant="outline"
                  className="h-12 w-full touch-manipulation"
                  disabled={busy !== null || !arrived || (v.visit.requireChecklist && left > 0)}
                  onClick={() => void ask()}
                >
                  {busy === "signoff" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {signoff.status === "pending" ? "Send it again" : "Ask the customer to confirm"}
                </Button>
              ) : null}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function PhotoSection({
  v,
  disabled,
  reload,
  onQueued,
  uid,
  base,
}: {
  v: TodayVisit;
  disabled: boolean;
  reload: () => Promise<void>;
  onQueued: () => Promise<void>;
  uid: string;
  base: string;
}) {
  const [label, setLabel] = useState<PhotoLabel>("before");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    let uploaded = 0;
    let queued = 0;
    for (const file of Array.from(files)) {
      try {
        const prepared = await preparePhoto(file);
        const res = await uploadOrQueue({
          subAccountId: v.subAccountId,
          visitId: v.visit.id,
          photo: prepared.photo,
          thumb: prepared.thumb,
          label,
          note: "",
          uid,
        });
        if (res === "uploaded") uploaded++;
        else if (res === "queued") queued++;
        else toast.error(res.error);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't read that photo.");
      }
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    if (library.current) library.current.value = "";
    if (uploaded) toast.success(`${uploaded} photo${uploaded === 1 ? "" : "s"} uploaded.`);
    if (queued) toast.message(`${queued} photo${queued === 1 ? "" : "s"} saved, waiting for signal.`);
    await onQueued();
    await reload();
  }

  return (
    <div className="space-y-2">
      <div role="group" aria-label="Photo type" className="flex gap-2 overflow-x-auto pb-1">
        {LABELS.map((l) => (
          <button
            key={l.id}
            type="button"
            aria-pressed={label === l.id}
            disabled={busy || disabled}
            onClick={() => setLabel(l.id)}
            className={`min-h-11 shrink-0 touch-manipulation rounded-full border px-4 text-sm font-medium disabled:opacity-60 ${
              label === l.id ? "border-primary bg-primary text-primary-foreground" : "active:bg-muted"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          className="h-14 touch-manipulation text-base"
          disabled={busy || disabled}
          onClick={() => input.current?.click()}
        >
          {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Camera className="mr-2 h-5 w-5" />}
          Take photo
        </Button>
        <Button
          variant="outline"
          className="h-14 touch-manipulation text-base"
          disabled={busy || disabled}
          onClick={() => library.current?.click()}
        >
          From library
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />
        <input
          ref={library}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Please keep people&apos;s faces out of photos where you can.
      </p>
      {v.visit.photos.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {v.visit.photos.map((p) => (
            <a
              key={p.id}
              href={`${base}/visits/${v.visit.id}/photos/${p.id}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${base}/visits/${v.visit.id}/photos/${p.id}?size=thumb`}
                alt={`${p.label} photo, open full size`}
                className="h-20 w-20 rounded-xl border object-cover"
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function PartsSection({
  v,
  base,
  reload,
}: {
  v: TodayVisit;
  base: string;
  reload: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [extra, setExtra] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  async function add() {
    const q = parseDecimalInput(qty);
    const p = price.trim() ? parseDecimalInput(price) : 0;
    if (q === null || q <= 0 || p === null) {
      toast.error("Check the quantity and price. Use numbers only, like 12.50.");
      return;
    }
    setBusy(true);
    const ok = await callApi(`${base}/visits/${v.visit.id}/materials`, "POST", {
      name,
      qty: q,
      unitPriceMinor: unitToMinor(v.job.currency, p),
      notInEstimate: extra,
    });
    setBusy(false);
    if (ok) {
      setName("");
      setQty("1");
      setPrice("");
      setExtra(false);
      await reload();
    }
  }

  return (
    <div className="space-y-3 rounded-xl border p-3">
      {v.materials.length > 0 && (
        <ul className="divide-y text-sm">
          {v.materials.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                {m.qty} {m.unit} · {m.name}
                {m.notInEstimate && (
                  <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">not in estimate</span>
                )}
              </span>
              <button
                className={TEXT_ACTION + " min-w-11 shrink-0 text-muted-foreground"}
                disabled={removing !== null}
                onClick={async () => {
                  setRemoving(m.id);
                  await callApi(`${base}/materials/${m.id}`, "DELETE");
                  await reload();
                  setRemoving(null);
                }}
              >
                {removing === m.id ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-6 gap-2">
        <div className="col-span-6">
          <Field label="Part used" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className={v.perms.prices ? "col-span-2" : "col-span-6"}>
          <Field label="Quantity" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
        {v.perms.prices && (
          <div className="col-span-4">
            <Field
              label={`Price each (${v.job.currency})`}
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
        )}
      </div>
      <label className="flex min-h-12 touch-manipulation items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="h-6 w-6 shrink-0"
          checked={extra}
          onChange={(e) => setExtra(e.target.checked)}
        />
        Extra work, not in the estimate
      </label>
      <Button className="h-12 w-full touch-manipulation" disabled={busy || !name.trim()} onClick={add}>
        Add part
      </Button>
    </div>
  );
}

const KIND_NOTE: Record<string, string> = {
  lump_sum: "Fixed price",
  time_and_materials: "Time and materials: billed on hours and parts",
  day_rate: "Billed by the day",
};

/** What the customer owes: charges plus parts, less the deposit and anything already collected on site, across the whole project. */
function pricingTotals(v: TodayVisit) {
  const p = v.job.pricing;
  const charges = p ? p.lines.reduce((n, l) => n + Math.round(l.qty * l.unitPriceMinor), 0) : 0;
  const parts = p ? p.parts.reduce((n, m) => n + Math.round(m.qty * m.unitPriceMinor), 0) : 0;
  const total = charges + parts;
  const deposit = p?.depositPaidMinor ?? 0;
  const collected = p?.collectedMinor ?? 0;
  return { charges, parts, total, deposit, collected, due: Math.max(0, total - deposit - collected) };
}

/** The big green amount still to collect. Once an invoice exists the invoice is what says what is owed. */
function DueBar({ v, large }: { v: TodayVisit; large?: boolean }) {
  const p = v.job.pricing;
  if (!p) return null;
  const t = pricingTotals(v);
  if (p.invoiced) {
    return (
      <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
        An invoice has been issued for this {v.jobWord.toLowerCase()}. What is still owed is on the invoice.
      </p>
    );
  }
  return (
    <p
      className={
        "flex items-center justify-between rounded-lg bg-green-600 px-3 font-bold text-white dark:bg-green-700 " +
        (large ? "py-3 text-lg" : "py-2 font-semibold")
      }
    >
      <span>{p.kind === "lump_sum" ? "Payment due" : "Due so far"}</span>
      <span>{formatMoneyCode(v.job.currency, t.due)}</span>
    </p>
  );
}

function PricingSection({ v }: { v: TodayVisit }) {
  const p = v.job.pricing;
  if (!p) return null;
  const cur = v.job.currency;
  const money = (minor: number) => formatMoneyCode(cur, minor);
  const t = pricingTotals(v);
  const hasParts = p.parts.length > 0;
  const row = (l: { id: string; description: string; qty: number; unitPriceMinor: number; extra?: boolean }) => (
    <li key={l.id} className="flex justify-between gap-3 py-1.5">
      <span className="min-w-0">
        {l.description}
        {l.extra ? <span className="text-muted-foreground"> (extra work)</span> : null}
        {l.qty !== 1 ? <span className="text-muted-foreground"> × {l.qty}</span> : null}
      </span>
      <span className="shrink-0">{money(Math.round(l.qty * l.unitPriceMinor))}</span>
    </li>
  );
  return (
    <div className="space-y-3 rounded-xl border p-3 text-sm">
      <p className="text-muted-foreground">{KIND_NOTE[p.kind] ?? ""}</p>
      {p.lines.length > 0 ? (
        <ul className="divide-y">{p.lines.map(row)}</ul>
      ) : (
        <p className="text-muted-foreground">No charges on this {v.jobWord.toLowerCase()} yet.</p>
      )}
      {hasParts && (
        <>
          <p className="flex justify-between border-t pt-2 text-muted-foreground">
            <span>Subtotal</span>
            <span>{money(t.charges)}</span>
          </p>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Parts</p>
            <ul className="divide-y">
              {p.parts.map((m) => (
                <li key={m.id} className="flex justify-between gap-3 py-1.5">
                  <span className="min-w-0">
                    {m.name}
                    {m.qty !== 1 ? <span className="text-muted-foreground"> × {m.qty}</span> : null}
                    {!m.here ? <span className="text-muted-foreground"> (another visit)</span> : null}
                  </span>
                  <span className="shrink-0">{money(Math.round(m.qty * m.unitPriceMinor))}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      <p className="flex justify-between border-t pt-2 text-base font-semibold">
        <span>Total</span>
        <span>{money(t.total)}</span>
      </p>
      {p.kind !== "lump_sum" && (
        <p className="text-xs text-muted-foreground">Hours worked are added when the invoice is made.</p>
      )}
      <p className="flex justify-between text-muted-foreground">
        <span>Deposit paid</span>
        <span>− {money(t.deposit)}</span>
      </p>
      {t.collected > 0 && (
        <p className="flex justify-between text-muted-foreground">
          <span>Collected on site</span>
          <span>− {money(t.collected)}</span>
        </p>
      )}
      <DueBar v={v} large />
      {p.estimate.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Estimate (not billed as such)</p>
          <ul className="divide-y">{p.estimate.map(row)}</ul>
        </div>
      )}
    </div>
  );
}

function PaymentSection({
  v,
  base,
  reload,
}: {
  v: TodayVisit;
  base: string;
  reload: () => Promise<void>;
}) {
  const [method, setMethod] = useState("cash");
  const [amount, setAmount] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [busy, setBusy] = useState(false);

  async function record() {
    const a = parseDecimalInput(amount);
    if (a === null || a <= 0) {
      toast.error("Enter the amount as a number, like 120.00.");
      return;
    }
    setBusy(true);
    const ok = await callApi(`${base}/visits/${v.visit.id}/payments`, "POST", {
      method,
      amountMinor: unitToMinor(v.job.currency, a),
      invoiceId: invoiceId || undefined,
    });
    setBusy(false);
    if (ok) {
      toast.success("Recorded. The office will confirm it.");
      setAmount("");
      await reload();
    }
  }

  return (
    <div className="space-y-3 rounded-xl border p-3">
      {v.payments.length > 0 && (
        <ul className="divide-y text-sm">
          {v.payments.map((p) => (
            <li key={p.id} className="flex justify-between gap-2 py-1.5">
              <span>
                {METHOD_LABELS[p.method] ?? p.method} · {formatMinor(v.job.currency, p.amountMinor)}
              </span>
              <span className="text-muted-foreground">{PAYMENT_STATUS_LABELS[p.status] ?? p.status}</span>
            </li>
          ))}
        </ul>
      )}
      <DueBar v={v} />
      <div className="grid grid-cols-2 gap-2">
        <FieldSelect
          label="How"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          options={METHOD_OPTIONS}
        />
        <Field
          label={`Amount (${v.job.currency})`}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      {v.job.invoiceIds.length > 0 && (
        <FieldSelect
          label="Which invoice"
          value={invoiceId}
          onChange={(e) => setInvoiceId(e.target.value)}
          options={[
            ["", "Not sure"],
            ...v.job.invoiceIds.map((id, i): [string, string] => [id, `Invoice ${i + 1}`]),
          ]}
        />
      )}
      <Button className="h-12 w-full touch-manipulation" disabled={busy || !((parseDecimalInput(amount) ?? 0) > 0)} onClick={record}>
        Record payment
      </Button>
    </div>
  );
}

function TimeEntries({
  v,
  base,
  reload,
}: {
  v: TodayVisit;
  base: string;
  reload: () => Promise<void>;
}) {
  const [askFor, setAskFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const done = v.timeEntries.filter((e) => !e.running);
  if (done.length === 0) return null;

  return (
    <div className="space-y-2 text-sm">
      <p className="text-sm font-medium text-muted-foreground">Recorded time</p>
      <ul className="divide-y rounded-xl border">
        {done.map((e) => (
          <li key={e.id} className="space-y-2 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span>
                {e.startAt ? formatInZone(new Date(e.startAt), v.job.timezone, { hour: "numeric", minute: "2-digit" }) : "—"}
                {" – "}
                {e.endAt ? formatInZone(new Date(e.endAt), v.job.timezone, { hour: "numeric", minute: "2-digit" }) : "—"}
              </span>
              {e.flagged ? (
                <span className="text-sm text-amber-700 dark:text-amber-400">Correction asked</span>
              ) : (
                <button className={TEXT_ACTION} onClick={() => setAskFor(askFor === e.id ? null : e.id)}>
                  Report a mistake
                </button>
              )}
            </div>
            {askFor === e.id && (
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field
                    label="What should it say?"
                    value={note}
                    onChange={(ev) => setNote(ev.target.value)}
                  />
                </div>
                <Button
                  className="h-12 touch-manipulation"
                  disabled={!note.trim()}
                  onClick={async () => {
                    const ok = await callApi(`${base}/time-entries/${e.id}`, "POST", { note });
                    if (ok) {
                      toast.success("Sent to the office.");
                      setAskFor(null);
                      setNote("");
                      await reload();
                    }
                  }}
                >
                  Send
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
