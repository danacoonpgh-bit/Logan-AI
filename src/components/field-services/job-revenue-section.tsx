"use client";

import { Fragment, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Checkbox } from "@/components/ui/checkbox";
import { formatMoneyCode } from "@/lib/field-services/money";
import type { Job } from "@/types/field-services";
import type { JobRevenue } from "@/lib/server/field-revenue-service";

const hoursText = (h: number) => `${h} h`;

function Tag({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "violet" | "amber" }) {
  const look =
    tone === "violet"
      ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
      : tone === "amber"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-medium ${look}`}>{children}</span>;
}

/** The revenue so far on one project: charge lines and extra work, booked time by person and activity, and parts. */
export function JobRevenueSection({ job, refreshKey }: { job: Job; refreshKey: string }) {
  const { subAccountId } = useSubAccount();
  const [wip, setWip] = useState(false);
  const [data, setData] = useState<JobRevenue | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetch(`/api/sub-accounts/${subAccountId}/field-services/jobs/${job.id}/revenue?wip=${wip ? 1 : 0}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<JobRevenue>) : Promise.reject(new Error("failed"))))
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [subAccountId, job.id, wip, refreshKey, job.lineItemsVersion]);

  if (failed) return <p className="text-sm text-muted-foreground">The revenue could not be loaded. Close and reopen the project to try again.</p>;
  if (!data)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading revenue…
      </p>
    );

  const money = (minor: number) => formatMoneyCode(data.currency, minor);
  const shownTotal =
    data.lines.reduce((n, l) => n + l.totalMinor, 0) +
    data.parts.reduce((n, p) => n + p.totalMinor, 0) +
    (data.labour?.valueMinor ?? 0);
  const nothing = data.lines.length === 0 && data.parts.length === 0 && (data.labour?.rows.length ?? 0) === 0;

  // rows grouped by person, the name shown once per group
  const labourRows = data.labour?.rows ?? [];
  const perPerson = new Map<string, { hours: number; value: number }>();
  for (const r of labourRows) {
    const cur = perPerson.get(r.workerId) ?? { hours: 0, value: 0 };
    perPerson.set(r.workerId, { hours: cur.hours + r.hours, value: cur.value + r.valueMinor });
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4">
        <div>
          <p className="text-xs text-muted-foreground">{wip ? "Work in progress" : "Revenue so far"}</p>
          <p className="text-2xl font-semibold tabular-nums">{money(wip ? data.totals.wipMinor : data.totals.totalMinor)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Invoiced {money(data.totals.invoicedMinor)} · Work in progress {money(data.totals.wipMinor)}
          </p>
          {data.estimateMinor !== null && data.estimateMinor > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Estimate {money(data.estimateMinor)} · {Math.round((data.totals.totalMinor / data.estimateMinor) * 100)}% used
            </p>
          )}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox checked={wip} onCheckedChange={(v) => setWip(v === true)} />
          Work in progress only
        </label>
      </div>

      {nothing && (
        <p className="text-sm text-muted-foreground">
          {wip ? "Nothing is waiting to be invoiced." : "Nothing has been earned on this project yet."}
        </p>
      )}

      {data.lines.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Charges</h3>
          <table className="w-full text-sm">
            <tbody className="divide-y">
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-2 pr-3">
                    {l.description}
                    {l.extraWork && <Tag tone="violet">Extra work</Tag>}
                    {l.invoiced && <Tag>Invoiced</Tag>}
                  </td>
                  <td className="w-16 py-2 text-right tabular-nums text-muted-foreground">{l.quantity !== 1 ? `× ${l.quantity}` : ""}</td>
                  <td className="w-28 py-2 text-right tabular-nums">{money(l.totalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.labour && labourRows.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Time</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-1 font-medium">Staff</th>
                <th className="pb-1 font-medium">Activity</th>
                <th className="pb-1 text-right font-medium">Hours</th>
                <th className="pb-1 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {labourRows.map((r, i) => {
                const first = i === 0 || labourRows[i - 1].workerId !== r.workerId;
                const last = i === labourRows.length - 1 || labourRows[i + 1].workerId !== r.workerId;
                const total = perPerson.get(r.workerId);
                return (
                  <Fragment key={`${r.workerId}|${r.activity}`}>
                    <tr>
                      <td className="py-2 pr-3 font-medium">{first ? r.workerName : ""}</td>
                      <td className="py-2 pr-3">
                        {r.activity}
                        {r.waitingHours > 0 && <Tag tone="amber">{hoursText(r.waitingHours)} waiting for approval</Tag>}
                      </td>
                      <td className="py-2 text-right tabular-nums">{hoursText(r.hours)}</td>
                      <td className="w-28 py-2 text-right tabular-nums">{money(r.valueMinor)}</td>
                    </tr>
                    {last && labourRows.filter((x) => x.workerId === r.workerId).length > 1 && total && (
                      <tr className="text-xs text-muted-foreground">
                        <td />
                        <td className="pb-2">{r.workerName} total</td>
                        <td className="pb-2 text-right tabular-nums">{hoursText(Math.round(total.hours * 100) / 100)}</td>
                        <td className="pb-2 text-right tabular-nums">{money(total.value)}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              <tr className="font-semibold">
                <td className="py-2" colSpan={2}>
                  Total time
                </td>
                <td className="py-2 text-right tabular-nums">{hoursText(data.labour.hours)}</td>
                <td className="py-2 text-right tabular-nums">{money(data.labour.valueMinor)}</td>
              </tr>
            </tbody>
          </table>
          {data.labour.missingRate.length > 0 && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              {data.labour.missingRate.join(", ")} {data.labour.missingRate.length === 1 ? "has" : "have"} no rate, so their time is not valued.
              Set it in their staff details.
            </p>
          )}
        </div>
      )}

      {!data.labour && (
        <p className="text-xs text-muted-foreground">
          This is a Fixed price project: time booked on it is for cost reporting only and is never invoiced.
        </p>
      )}

      {data.parts.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Parts</h3>
          <table className="w-full text-sm">
            <tbody className="divide-y">
              {data.parts.map((p) => (
                <tr key={p.id}>
                  <td className="py-2 pr-3">
                    {p.name}
                    {p.invoiced && <Tag>Invoiced</Tag>}
                  </td>
                  <td className="w-24 py-2 text-right tabular-nums text-muted-foreground">
                    {p.quantity} {p.unit}
                  </td>
                  <td className="w-28 py-2 text-right tabular-nums">{money(p.totalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!nothing && (
        <div className="flex items-center justify-between border-t pt-3 text-sm font-semibold">
          <span>{wip ? "Total work in progress" : "Total revenue"}</span>
          <span className="tabular-nums">{money(shownTotal)}</span>
        </div>
      )}
    </section>
  );
}
