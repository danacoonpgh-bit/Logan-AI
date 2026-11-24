"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { QuoteStatusBadge } from "@/components/quotes/quote-status-badge";
import { formatCurrency } from "@/lib/format";
import type { IssuedDocument } from "@/lib/server/field-documents-service";
import type { Job } from "@/types/field-services";

/** Estimates and invoices already made for this project, with a link to each and to the Invoicing module. */
export function JobIssuedInvoices({ job }: { job: Job }) {
  const { subAccountId, saPath } = useSubAccount();
  const [docs, setDocs] = useState<IssuedDocument[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetch(`/api/sub-accounts/${subAccountId}/field-services/jobs/${job.id}/issued`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ documents: IssuedDocument[] }>) : Promise.reject(new Error("failed"))))
      .then((d) => !cancelled && setDocs(d.documents))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [subAccountId, job.id, job.invoiceIds.length, job.quoteId]);

  if (failed) return <p className="text-sm text-muted-foreground">The invoices could not be loaded. Close and reopen the project to try again.</p>;
  if (!docs)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
      </p>
    );

  return (
    <div className="space-y-3">
      {docs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No estimates or invoices have been made for this project yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Number</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Issued</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="px-3 py-2 font-medium">
                    <Link className="underline-offset-2 hover:underline" href={saPath(`/quotes/${d.id}`)}>
                      {d.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{d.kind === "invoice" ? "Invoice" : "Estimate"}</td>
                  <td className="px-3 py-2">
                    <QuoteStatusBadge status={d.status} />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {d.issuedAtMs ? new Date(d.issuedAtMs).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "Not sent"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(d.total, d.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Link className="inline-block text-sm text-primary underline-offset-2 hover:underline" href={saPath("/quotes")}>
        Open the Invoicing module
      </Link>
    </div>
  );
}
