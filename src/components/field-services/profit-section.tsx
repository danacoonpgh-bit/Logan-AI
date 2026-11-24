"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { formatMinor } from "@/lib/field-services/money";
import { jobTerms } from "@/lib/field-services/terms";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import type { ProfitReport } from "@/lib/server/field-profit-report-service";

function pct(margin: number, revenue: number): string {
  return revenue > 0 ? `${Math.round((margin / revenue) * 100)}%` : "–";
}

const NEG = "text-destructive";

/** Profit and loss for the projects created in the period, and rolled up by service. Needs cost rates on staff. */
export function ProfitSection({ days }: { days: number }) {
  const { subAccountId } = useSubAccount();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const [report, setReport] = useState<ProfitReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError("");
    void fetch(`/api/sub-accounts/${subAccountId}/field-services/reports?view=profit&days=${days}`, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as ProfitReport & { error?: string };
        if (cancelled) return;
        if (!res.ok) setError(data.error ?? "Couldn't load the profit report.");
        else setReport(data);
      })
      .catch(() => !cancelled && setError("Couldn't load the profit report."));
    return () => {
      cancelled = true;
    };
  }, [subAccountId, days]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!report) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading profit…
      </p>
    );
  }
  const unpriced = report.rows.reduce((n, r) => n + r.unpricedHours, 0);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Profit by {terms.job}</h2>
        <p className="text-sm text-muted-foreground">
          Revenue is what was invoiced without tax. Cost is logged hours at each person&apos;s cost rate, parts at cost and expense claims.
          {unpriced > 0 ? ` ${Math.round(unpriced * 100) / 100} hours have no cost rate yet, so they are not counted.` : ""}
          {report.capped ? " Showing the latest 200." : ""}
        </p>
        {report.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No {terms.jobs} were created in this period.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border bg-card">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">{terms.Job}</th>
                  <th className="p-3">Service</th>
                  <th className="p-3 text-right">Revenue</th>
                  <th className="p-3 text-right">Hours</th>
                  <th className="p-3 text-right">Labour</th>
                  <th className="p-3 text-right">Parts</th>
                  <th className="p-3 text-right">Expenses</th>
                  <th className="p-3 text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.jobId} className="border-t">
                    <td className="max-w-[16rem] p-3">
                      <span className="block truncate font-medium">{r.title}</span>
                      <span className="block text-xs text-muted-foreground">{r.number}</span>
                    </td>
                    <td className="p-3 text-muted-foreground">{r.service || "–"}</td>
                    <td className="p-3 text-right tabular-nums">
                      {formatMinor(r.currency, r.revenueMinor)}
                    </td>
                    <td className="p-3 text-right tabular-nums">{r.labourHours}</td>
                    <td className="p-3 text-right tabular-nums">{formatMinor(r.currency, r.labourCostMinor)}</td>
                    <td className="p-3 text-right tabular-nums">{formatMinor(r.currency, r.partsCostMinor)}</td>
                    <td className="p-3 text-right tabular-nums">{formatMinor(r.currency, r.expensesMinor)}</td>
                    <td className={`p-3 text-right font-medium tabular-nums ${r.marginMinor < 0 ? NEG : ""}`}>
                      {formatMinor(r.currency, r.marginMinor)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">{pct(r.marginMinor, r.revenueMinor)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {report.services.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Profit by service</h2>
          <div className="overflow-x-auto rounded-2xl border bg-card">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Service</th>
                  <th className="p-3 text-right">{terms.Jobs}</th>
                  <th className="p-3 text-right">Revenue</th>
                  <th className="p-3 text-right">Cost</th>
                  <th className="p-3 text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {report.services.map((s) => (
                  <tr key={`${s.currency}|${s.service}`} className="border-t">
                    <td className="p-3 font-medium">{s.service || "No service or several"}</td>
                    <td className="p-3 text-right tabular-nums">{s.jobs}</td>
                    <td className="p-3 text-right tabular-nums">{formatMinor(s.currency, s.revenueMinor)}</td>
                    <td className="p-3 text-right tabular-nums">{formatMinor(s.currency, s.costMinor)}</td>
                    <td className={`p-3 text-right font-medium tabular-nums ${s.marginMinor < 0 ? NEG : ""}`}>
                      {formatMinor(s.currency, s.marginMinor)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">{pct(s.marginMinor, s.revenueMinor)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
