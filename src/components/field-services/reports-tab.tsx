"use client";

import { ProfitSection } from "@/components/field-services/profit-section";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { formatMinor } from "@/lib/field-services/money";
import type { FieldReport } from "@/lib/server/field-reports-service";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { jobTerms, workerTerms } from "@/lib/field-services/terms";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
];

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ReportsTab() {
  const { subAccountId, isAdmin } = useSubAccount();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const wt = workerTerms(config);
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<FieldReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setReport(null);
    setError("");
    void fetch(`/api/sub-accounts/${subAccountId}/field-services/reports?days=${days}`, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as FieldReport & { error?: string };
        if (cancelled) return;
        if (!res.ok) setError(data.error ?? "Couldn't load the report.");
        else setReport(data);
      })
      .catch(() => !cancelled && setError("Couldn't load the report."));
    return () => {
      cancelled = true;
    };
  }, [subAccountId, days, isAdmin]);

  if (!isAdmin) {
    return (
      <p className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        Reports show costs and revenue, so only workspace admins can see them.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <button
            key={r.days}
            onClick={() => setDays(r.days)}
            className={
              "rounded-full border px-3 py-1.5 text-sm " +
              (days === r.days ? "bg-primary text-primary-foreground" : "hover:bg-muted")
            }
          >
            {r.label}
          </button>
        ))}
        <span className="text-xs text-muted-foreground">{terms.Jobs} created in this period</span>
      </div>

      {error ? (
        <p className="text-sm text-muted-foreground">{error}</p>
      ) : !report ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : (
        <>
          {report.jobs.capped && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
              This period has more than 200 {terms.jobs}, so only the newest 200 are counted. Pick a shorter period.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card label="Requests" value={String(report.requests.created)} hint={`${report.requests.converted} became ${terms.jobs}`} />
            <Card label={`${terms.Jobs} created`} value={String(report.jobs.created)} hint={`${report.jobs.cancelled} cancelled`} />
            <Card label={`${terms.Jobs} finished`} value={String(report.jobs.completed)} />
            <Card
              label="Average time to finish"
              value={report.jobs.avgDaysToComplete === null ? "—" : `${report.jobs.avgDaysToComplete} days`}
              hint="From created to the last visit done"
            />
          </div>

          <section className="space-y-2">
            <h2 className="text-base font-semibold">{wt.Workers}</h2>
            {report.workers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No visits or time logged on these {terms.jobs} yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-2xl border bg-card">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="p-3">{wt.Worker}</th>
                      <th className="p-3">Visits done</th>
                      <th className="p-3">Hours logged</th>
                      <th className="p-3">Billable hours</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {report.workers.map((w) => (
                      <tr key={w.workerId}>
                        <td className="p-3 font-medium">{w.name}</td>
                        <td className="p-3">{w.visitsCompleted}</td>
                        <td className="p-3">{w.hours}</td>
                        <td className="p-3">{w.billableHours}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold">Money</h2>
            {report.money.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing invoiced or logged on these {terms.jobs} yet.</p>
            ) : (
              report.money.map((m) => (
                <div key={m.currency} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <Card label="Invoiced" value={formatMinor(m.currency, m.invoiced)} />
                  <Card label="Paid" value={formatMinor(m.currency, m.paid)} />
                  <Card label="Parts sold" value={formatMinor(m.currency, m.partsPrice)} />
                  <Card
                    label="Parts cost"
                    value={formatMinor(m.currency, m.partsCost)}
                    hint={
                      m.partsPrice > 0
                        ? `Margin ${formatMinor(m.currency, m.partsPrice - m.partsCost)}`
                        : undefined
                    }
                  />
                  <Card label="Collected on site" value={formatMinor(m.currency, m.onSiteConfirmed)} hint="Confirmed" />
                </div>
              ))
            )}
          </section>
          <ProfitSection days={days} />
        </>
      )}
    </div>
  );
}
