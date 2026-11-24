"use client";

import { useEffect, useMemo, useState } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { useFieldData } from "@/components/field-services/field-data";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { dashboardMetrics } from "@/lib/field-services/dashboard-metrics";
import { formatMoneyCode } from "@/lib/field-services/money";
import { jobTerms } from "@/lib/field-services/terms";
import { cn } from "@/lib/utils";
import type { DashboardServerStats } from "@/lib/server/field-dashboard-service";

export type JobsFilter = "active" | "unscheduled" | "ready_to_invoice" | "closed" | "all";

function hours(min: number): string {
  const h = min / 60;
  return h >= 10 ? String(Math.round(h)) : (Math.round(h * 10) / 10).toString();
}

function Card({
  title,
  value,
  note,
  tone,
  onClick,
  children,
}: {
  title: string;
  value: string;
  note?: string;
  tone?: "alert" | "ok";
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[7.5rem] flex-col rounded-2xl border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/30"
    >
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <span
        className={cn(
          "mt-1 text-3xl font-semibold tabular-nums tracking-tight",
          tone === "alert" && "text-amber-600 dark:text-amber-400",
          tone === "ok" && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {value}
      </span>
      {note && <span className="mt-1 text-xs text-muted-foreground">{note}</span>}
      {children}
    </button>
  );
}

/** The Home tab: the few numbers that say what needs doing and how busy the team is. Each card opens the list behind it. */
export function FieldDashboardTab({
  onGoJobs,
  onGoTab,
}: {
  onGoJobs: (filter: JobsFilter) => void;
  onGoTab: (tab: "schedule" | "timesheets" | "reports" | "workers") => void;
}) {
  const { jobs, visits, workers, requests, loaded } = useFieldData();
  const { subAccount, subAccountId, isAdmin } = useSubAccount();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const tz = (typeof subAccount?.timezone === "string" && subAccount.timezone) || "UTC";
  const [server, setServer] = useState<DashboardServerStats | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetch(`/api/sub-accounts/${subAccountId}/field-services/dashboard`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DashboardServerStats | null) => {
        if (!cancelled && d) setServer(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAdmin, subAccountId]);

  const m = useMemo(() => dashboardMetrics({ jobs, visits, workers, requests, now, tz }), [jobs, visits, workers, requests, now, tz]);
  const timesheetsOn = config?.timesheetsEnabled === true;

  if (!loaded) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-[7.5rem] animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
        ))}
      </div>
    );
  }

  const attention = m.late + m.unassigned;
  const util = m.utilisation;
  const money = server?.money?.[0] ?? null;
  const freeMin = Math.max(0, m.availableMin - m.bookedMin);

  return (
    <div className="space-y-6">
      <section aria-label="Needs attention" className="space-y-2">
        <h2 className="text-sm font-semibold">Needs attention</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card
            title={`${terms.Jobs} to schedule`}
            value={String(m.toSchedule)}
            note={m.toSchedule === 0 ? "Everything has a time" : "Waiting for a visit"}
            tone={m.toSchedule > 0 ? "alert" : "ok"}
            onClick={() => onGoJobs("unscheduled")}
          />
          <Card
            title="Late or unassigned visits"
            value={String(attention)}
            note={attention === 0 ? "All on track" : `${m.late} late, ${m.unassigned} with nobody on them`}
            tone={attention > 0 ? "alert" : "ok"}
            onClick={() => onGoTab("schedule")}
          />
          {timesheetsOn && isAdmin ? (
            <Card
              title="Timesheets to approve"
              value={server?.timesheetsToApprove == null ? "–" : String(server.timesheetsToApprove)}
              note={server?.timesheetsToApprove ? "Weeks sent in by staff" : "Nothing waiting"}
              tone={server?.timesheetsToApprove ? "alert" : undefined}
              onClick={() => onGoTab("timesheets")}
            />
          ) : (
            <Card
              title="Staff"
              value={String(m.staffActive)}
              note={m.staffAway > 0 ? `${m.staffAway} away today` : "All available"}
              onClick={() => onGoTab("workers")}
            />
          )}
          <Card
            title="Ready to invoice"
            value={String(m.readyToInvoice)}
            note={m.readyToInvoice === 0 ? "Nothing finished and unbilled" : `${terms.Jobs} finished, not yet billed`}
            tone={m.readyToInvoice > 0 ? "alert" : undefined}
            onClick={() => onGoJobs("ready_to_invoice")}
          />
        </div>
      </section>

      <section aria-label="How busy we are" className="space-y-2">
        <h2 className="text-sm font-semibold">How busy we are</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card title={`Open ${terms.jobs}`} value={String(m.openJobs)} note="Not closed or cancelled" onClick={() => onGoJobs("active")} />
          <Card
            title="Utilisation, next 7 days"
            value={util === null ? "–" : `${util}%`}
            note={util === null ? "Set working hours for your staff" : `${hours(m.bookedMin)} h booked of ${hours(m.availableMin)} h`}
            tone={util !== null && util > 100 ? "alert" : undefined}
            onClick={() => onGoTab("schedule")}
          >
            {util !== null && (
              <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, util)}%` }} />
              </span>
            )}
          </Card>
          <Card
            title="Open capacity"
            value={util === null ? "–" : `${hours(freeMin)} h`}
            note={`${m.staffActive} ${m.staffActive === 1 ? "person" : "people"}${m.staffAway > 0 ? `, ${m.staffAway} away today` : ""}`}
            onClick={() => onGoTab("workers")}
          />
          {isAdmin && (
            <Card
              title="Billed this month"
              value={money ? formatMoneyCode(money.currency, money.billedMinor) : "–"}
              note={money ? `${formatMoneyCode(money.currency, money.paidMinor)} paid` : "Invoices on your projects"}
              onClick={() => onGoTab("reports")}
            />
          )}
        </div>
      </section>

      {m.people.length > 0 && (
        <section aria-label="Load by person" className="space-y-2">
          <h2 className="text-sm font-semibold">Next 7 days by person</h2>
          <ul className="divide-y rounded-2xl border bg-card">
            {m.people.map((p) => {
              const pct = p.availableMin > 0 ? Math.round((p.bookedMin / p.availableMin) * 100) : null;
              return (
                <li key={p.id} className="flex items-center gap-3 p-3 text-sm">
                  <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  <span className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-muted sm:block">
                    <span
                      className={cn("block h-full rounded-full", pct !== null && pct > 100 ? "bg-amber-500" : "bg-primary")}
                      style={{ width: `${Math.min(100, pct ?? 0)}%` }}
                    />
                  </span>
                  <span className="w-28 shrink-0 text-right tabular-nums text-muted-foreground">
                    {p.availableMin > 0 ? `${hours(p.bookedMin)} of ${hours(p.availableMin)} h` : "No hours set"}
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums">{pct === null ? "" : `${pct}%`}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
