"use client";

import { useEffect, useState } from "react";
import { CalendarCheck, CircleHelp, Clock, Loader2, Route as RouteIcon, Timer, UserRound } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CrewTime } from "@/components/field-services/crew-time";
import { TodayView } from "@/components/field-services/today-view";
import { cn } from "@/lib/utils";
import { dropThisDevice } from "@/components/field-portal/use-crew-push";
import { HelpGuide } from "@/components/field-portal/help-guide";
import { RouteView } from "@/components/field-portal/route-view";
import { InstallCard, InstallSection } from "@/components/field-portal/install-card";
import { AlertsPrompt, VisitAlertsCard } from "@/components/field-portal/visit-alerts-card";

interface Me {
  person: { name: string; email?: string | null; phone?: string | null };
  businesses: { subAccountId: string; name: string; timesheets: boolean; jobWord: string; jobWordPlural: string }[];
  devices: { id: string; label: string; lastSeenAt: number; current: boolean }[];
}

type Tab = "day" | "route" | "time" | "me" | "help";

interface RunningTimer {
  label: string;
  startAt: string;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ElapsedClock({ startAt }: { startAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{formatElapsed(now - new Date(startAt).getTime())}</span>;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (!ms || diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function deviceName(label: string): string {
  if (/iPhone/.test(label)) return "iPhone";
  if (/iPad/.test(label)) return "iPad";
  if (/Android/.test(label)) return "Android phone";
  if (/Windows/.test(label)) return "Windows computer";
  if (/Macintosh/.test(label)) return "Mac";
  return "Phone";
}

const THEME_OPTIONS = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

/** Today's date on this phone, worked out after mount so the server's locale cannot mismatch it. */
function useTodayLabel(): string {
  const [label, setLabel] = useState("");
  useEffect(() => {
    const set = () => setLabel(new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }));
    set();
    const t = setInterval(set, 60_000);
    return () => clearInterval(t);
  }, []);
  return label;
}

function ThemeControl() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? (theme ?? "system") : "";

  return (
    <section className="space-y-2">
      <h2 className="text-base font-medium">Appearance</h2>
      <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-1 rounded-xl border p-1">
        {THEME_OPTIONS.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={current === o.id}
            onClick={() => setTheme(o.id)}
            className={cn(
              "min-h-11 touch-manipulation rounded-lg text-base font-medium active:opacity-60",
              current === o.id ? "bg-primary text-primary-foreground" : "text-muted-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function FieldHome({ subAccountId, brandName = "" }: { subAccountId: string; brandName?: string }) {
  const [tab, setTab] = useState<Tab>("day");
  const [me, setMe] = useState<Me | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [daySummary, setDaySummary] = useState<{ assigned: number; completed: number; nextDay: string | null } | null>(null);
  // A day picked with See route on My day; n makes picking the same day again count.
  const [routeJump, setRouteJump] = useState<{ day: string; n: number } | null>(null);
  const todayLabel = useTodayLabel();
  // One entry per business, because a person can have a timer running in more than one.
  const [timers, setTimers] = useState<Record<string, RunningTimer>>({});
  const timer = Object.values(timers).sort((a, b) => b.startAt.localeCompare(a.startAt))[0] ?? null;
  const [signingOut, setSigningOut] = useState<"" | "this" | "all">("");
  const [confirmAll, setConfirmAll] = useState(false);
  const timeBusinesses = me?.businesses.filter((b) => b.timesheets) ?? [];
  // The Route tab is for people with visits today or in the next week.
  const hasRoute = (daySummary?.assigned ?? 0) > 0 || !!daySummary?.nextDay;
  const activeTab: Tab = (tab === "time" && timeBusinesses.length === 0) || (tab === "route" && !hasRoute) ? "day" : tab;

  async function loadMe() {
    const res = await fetch("/api/field-portal/me", { cache: "no-store" }).catch(() => null);
    if (res?.status === 401) {
      window.location.replace(`/field/${subAccountId}/login`);
      return;
    }
    if (res?.ok) {
      setMe((await res.json()) as Me);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
  }

  function retryLoad() {
    setLoadFailed(false);
    void loadMe();
  }

  useEffect(() => {
    void loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once for this workspace
  }, [subAccountId]);

  useEffect(() => {
    function onTimer(e: Event) {
      const detail = (e as CustomEvent<{ key?: string; timer: RunningTimer | null } | null>).detail;
      const key = String(detail?.key ?? "");
      const next = detail?.timer;
      setTimers((cur) => {
        const rest = { ...cur };
        if (next && next.startAt) rest[key] = { label: String(next.label ?? ""), startAt: next.startAt };
        else delete rest[key];
        return rest;
      });
    }
    window.addEventListener("field-timer", onTimer);
    return () => window.removeEventListener("field-timer", onTimer);
  }, []);

  function selectTab(next: Tab) {
    setTab(next);
    window.scrollTo({ top: 0 });
  }

  async function signOut() {
    setSigningOut("this");
    await dropThisDevice();
    const res = await fetch("/api/field-portal/logout", { method: "POST" }).catch(() => null);
    if (!res?.ok) {
      setSigningOut("");
      toast.error("Couldn't sign out. Check your connection and try again.");
      return;
    }
    window.location.replace(`/field/${subAccountId}/login`);
  }

  async function signOutAll() {
    setSigningOut("all");
    await dropThisDevice();
    const res = await fetch("/api/field-portal/signout-all", { method: "POST" }).catch(() => null);
    if (!res?.ok) {
      setSigningOut("");
      toast.error("Couldn't sign out of every phone. Check your connection and try again.");
      return;
    }
    window.location.replace(`/field/${subAccountId}/login`);
  }

  async function removeDevice(id: string) {
    await fetch(`/api/field-portal/devices/${id}`, { method: "DELETE" }).catch(() => {});
    await loadMe();
  }

  const showStrip = !!timer && activeTab !== "time";

  return (
    <div className="flex min-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-full flex-col">
      {!me && (
        <div role="status" className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          {loadFailed ? (
            <>
              <p className="text-base text-muted-foreground">Couldn&apos;t load. Check your connection and try again.</p>
              <Button className="h-12 touch-manipulation" onClick={retryLoad}>
                Try again
              </Button>
            </>
          ) : (
            <>
              {brandName && <p className="text-lg font-semibold">{brandName}</p>}
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">Loading…</p>
            </>
          )}
        </div>
      )}
      <main hidden={!me} className="mx-auto w-full max-w-md flex-1 p-4 pb-6 lg:max-w-5xl lg:p-6 lg:pb-8">
        <div hidden={activeTab !== "day"} className="space-y-4">
          <div className="flex items-end justify-between gap-3">
            <h1 className="text-2xl font-semibold">My day</h1>
            <div className="text-right">
              <p className="text-sm font-medium">
                {todayLabel}
              </p>
              {daySummary && (
                <p className="text-xs text-muted-foreground">
                  Assigned: {daySummary.assigned} · Completed: {daySummary.completed}
                </p>
              )}
            </div>
          </div>
          <InstallCard />
          <AlertsPrompt />
          <TodayView
            endpoint="/api/field-portal/today"
            portal
            onSummary={setDaySummary}
            onSeeRoute={(day) => {
              setRouteJump((j) => ({ day, n: (j?.n ?? 0) + 1 }));
              setTab("route");
            }}
          />
        </div>
        {hasRoute && (
          <div hidden={activeTab !== "route"}>
            <RouteView
              active={activeTab === "route"}
              timezone={Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
              startDay={(daySummary?.assigned ?? 0) > 0 ? null : (daySummary?.nextDay ?? null)}
              jump={routeJump}
            />
          </div>
        )}
        {timeBusinesses.length > 0 && (
          <div hidden={activeTab !== "time"} className="space-y-6">
            <h1 className="text-2xl font-semibold">My time</h1>
            {timeBusinesses.map((b) => (
              <CrewTime
                key={b.subAccountId}
                endpoint={`/api/field-portal/${b.subAccountId}/time`}
                portal
                fab={timeBusinesses.length === 1}
                wide
                heading={timeBusinesses.length > 1 ? b.name : undefined}
              />
            ))}
          </div>
        )}
        <div hidden={activeTab !== "help"}>
          <HelpGuide />
        </div>
        <div hidden={activeTab !== "me"} className="space-y-5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5 lg:space-y-0">
          <h1 className="text-2xl font-semibold lg:col-span-2">Hi {me?.person.name || "there"}</h1>
          <section className="space-y-2">
            <h2 className="text-base font-medium">My details</h2>
            <dl className="divide-y rounded-xl border text-base">
              {[
                ["Name", me?.person.name],
                ["Email", me?.person.email],
                ["Mobile", me?.person.phone],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 p-3">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 truncate text-right">{value || "Not set"}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-muted-foreground">Your employer keeps these. Ask them if something needs changing.</p>
          </section>
          <InstallSection />
          <VisitAlertsCard />
          <ThemeControl />
          <section className="space-y-2">
            <h2 className="text-base font-medium">Your company</h2>
            {!me && <div className="h-14 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />}
            {me && me.businesses.length === 0 && (
              <p className="text-base text-muted-foreground">
                You aren&apos;t set up here right now. Ask your employer to add you.
              </p>
            )}
            <ul className="space-y-2">
              {me?.businesses.map((b) => (
                <li key={b.subAccountId} className="flex items-center justify-between gap-3 rounded-xl border p-4 text-base">
                  <span className="min-w-0 truncate font-medium">{b.name}</span>
                  <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    Active
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="space-y-2">
            <h2 className="text-base font-medium">Signed-in devices</h2>
            <ul className="space-y-2">
              {me?.devices.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                  <span className="min-w-0">
                    <span className="block truncate text-base">{d.current ? "This device" : deviceName(d.label)}</span>
                    {!d.current && (
                      <span className="block text-sm text-muted-foreground">Last used {relativeTime(d.lastSeenAt)}</span>
                    )}
                  </span>
                  {!d.current && (
                    <button
                      className="min-h-11 touch-manipulation px-2 text-sm underline"
                      onClick={() => void removeDevice(d.id)}
                    >
                      Sign out
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <div className="space-y-2">
            <Button
              variant="outline"
              className="h-12 w-full touch-manipulation"
              disabled={signingOut !== ""}
              onClick={() => void signOut()}
            >
              {signingOut === "this" && <Loader2 className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none" />}
              Sign out of this device
            </Button>
          </div>
          <section className="space-y-3 rounded-xl border border-destructive/30 p-4">
            <h2 className="text-base font-medium">Lost a phone or device?</h2>
            <p className="text-sm text-muted-foreground">Signs you out everywhere, including this device.</p>
            {confirmAll ? (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="h-12 touch-manipulation"
                  disabled={signingOut !== ""}
                  onClick={() => setConfirmAll(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  className="h-12 touch-manipulation"
                  disabled={signingOut !== ""}
                  onClick={() => void signOutAll()}
                >
                  {signingOut === "all" && <Loader2 className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none" />}
                  Yes, sign out all
                </Button>
              </div>
            ) : (
              <Button
                variant="destructive"
                className="h-12 w-full touch-manipulation"
                disabled={signingOut !== ""}
                onClick={() => setConfirmAll(true)}
              >
                Sign out everywhere
              </Button>
            )}
          </section>
        </div>
      </main>
      <div hidden={!me} className="sticky bottom-0 z-40 lg:top-0 lg:bottom-auto lg:order-first">
      {showStrip && timer && (
        <button
          onClick={() => selectTab("time")}
          className="flex h-10 w-full touch-manipulation items-center justify-center gap-2 bg-primary pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-sm font-medium text-primary-foreground active:opacity-80"
        >
          <Timer className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">
            Timer running <ElapsedClock startAt={timer.startAt} />
            {timer.label ? ` · ${timer.label}` : ""}
          </span>
        </button>
      )}
      <nav
        aria-label="Primary"
        className="border-t bg-background/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur lg:border-b lg:border-t-0 lg:pb-0"
      >
        <div className="mx-auto flex h-16 max-w-md items-stretch lg:h-14 lg:max-w-5xl lg:justify-center lg:gap-1 lg:px-6">
          {(
            [
              { id: "day", label: "My day", icon: CalendarCheck },
              ...(hasRoute ? [{ id: "route", label: "Route", icon: RouteIcon } as const] : []),
              ...(timeBusinesses.length > 0 ? [{ id: "time", label: "Time", icon: Clock } as const] : []),
              { id: "me", label: "Me", icon: UserRound },
              { id: "help", label: "Help", icon: CircleHelp },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => selectTab(t.id)}
              aria-current={activeTab === t.id ? "page" : undefined}
              className={cn(
                "flex flex-1 touch-manipulation select-none flex-col items-center justify-center gap-0.5 text-xs font-medium active:opacity-60 lg:flex-none lg:flex-row lg:gap-2 lg:px-4 lg:text-sm",
                activeTab === t.id ? "text-primary" : "text-muted-foreground",
              )}
            >
              <t.icon className="h-6 w-6 lg:h-5 lg:w-5" aria-hidden="true" />
              {t.label}
            </button>
          ))}
        </div>
      </nav>
      </div>
    </div>
  );
}
