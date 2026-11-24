"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Plus } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { formatServiceAddress } from "@/lib/field-services/address";
import { useFieldData } from "@/components/field-services/field-data";
import { NewRequestDialog } from "@/components/field-services/new-request-dialog";
import { RequestStatusPill, callApi } from "@/components/field-services/field-ui";
import { formatRelativeTime } from "@/lib/format";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { jobTerms, withArticle, type JobTerms } from "@/lib/field-services/terms";
import type { ServiceRequestStatus } from "@/types/field-services";

type Filter = "open" | ServiceRequestStatus | "all";

const filtersFor = (terms: JobTerms): { id: Filter; label: string }[] => [
  { id: "open", label: "Open" },
  { id: "converted", label: `Became ${withArticle(terms.job)}` },
  { id: "archived", label: "Archived" },
  { id: "all", label: "All" },
];

const OPEN: ServiceRequestStatus[] = ["new", "scheduled", "action_required"];

export function RequestsTab({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const { subAccountId, isAdmin } = useSubAccount();
  const { requests, contacts, loaded } = useFieldData();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const [filter, setFilter] = useState<Filter>("open");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const shown = useMemo(
    () =>
      requests.filter((r) =>
        filter === "all"
          ? true
          : filter === "open"
            ? OPEN.includes(r.status)
            : r.status === filter,
      ),
    [requests, filter],
  );

  const base = `/api/sub-accounts/${subAccountId}/field-services/requests`;

  async function convert(id: string) {
    setBusyId(id);
    const res = await callApi<{ id: string; number: string }>(`${base}/${id}/convert`, "POST", {});
    setBusyId(null);
    if (res) {
      toast.success(`${terms.Job} ${res.number} created.`);
      onOpenJob(res.id);
    }
  }

  async function setStatus(id: string, status: "archived" | "new") {
    setBusyId(id);
    await callApi(`${base}/${id}`, "PATCH", { status });
    setBusyId(null);
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Requests</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            What customers have asked for. Turn a request into {withArticle(terms.job)} when you
            are ready to schedule it.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" /> New request
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {filtersFor(terms).map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium " +
              (filter === f.id ? "border-primary bg-primary/10" : "hover:bg-muted")
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {!loaded ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ul className="mt-4 divide-y rounded-lg border">
          {shown.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="text-muted-foreground">{r.number}</span>
                  <span className="truncate">{r.title}</span>
                  <RequestStatusPill status={r.status} terms={terms} />
                  {r.outOfArea && (
                    <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" /> Outside your areas
                    </span>
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {r.contactName}
                  {r.serviceAddress ? ` · ${formatServiceAddress(r.serviceAddress)}` : ""}
                  {" · "}
                  {formatRelativeTime(r.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {r.status === "converted" && r.convertedTo ? (
                  <Button variant="outline" size="sm" onClick={() => onOpenJob(r.convertedTo!)}>
                    Open {terms.job} <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                ) : r.status === "archived" ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === r.id}
                      onClick={() => void setStatus(r.id, "new")}
                    >
                      Restore
                    </Button>
                    {isAdmin && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId === r.id}
                        onClick={async () => {
                          setBusyId(r.id);
                          await callApi(`${base}/${r.id}`, "DELETE");
                          setBusyId(null);
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      disabled={busyId === r.id}
                      onClick={() => void convert(r.id)}
                    >
                      Create {terms.job}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === r.id}
                      onClick={() => void setStatus(r.id, "archived")}
                    >
                      Archive
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <NewRequestDialog open={creating} onOpenChange={setCreating} contacts={contacts} />
    </section>
  );
}
