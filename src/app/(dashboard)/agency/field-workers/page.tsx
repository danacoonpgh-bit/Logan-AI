"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

interface Row {
  workerId: string;
  subAccountId: string;
  subAccountName: string;
  name: string;
  kind: string;
  status: string;
  source: "member" | "crew-app";
  portalStatus: string | null;
  contact: string;
  personId: string | null;
}

const PORTAL_LABEL: Record<string, string> = {
  invited: "invite sent",
  active: "joined",
  revoked: "no access",
  none: "not invited",
};

interface UsageRow {
  subAccountId: string;
  name: string;
  requests: number;
  jobs: number;
  jobsDone: number;
  visitsDone: number;
  timeEntries: number;
  payments: number;
}

interface FeedbackRow {
  id: string;
  subAccountName: string;
  helpful: boolean | null;
  text: string;
  source: string;
  at: number;
}

export default function AgencyFieldWorkersPage() {
  const { agencyRole, loading: authLoading } = useAuth();
  const isOwner = agencyRole === "owner";
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);

  useEffect(() => {
    if (!isOwner) return;
    void fetch("/api/agency/field-feedback", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { usage: UsageRow[]; feedback: FeedbackRow[] };
        setUsage(data.usage);
        setFeedback(data.feedback);
      })
      .catch(() => {});
    void fetch("/api/agency/field-workers", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error("bad");
        setRows(((await res.json()) as { rows: Row[] }).rows);
      })
      .catch(() => setError(true));
  }, [isOwner]);

  const people = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of rows ?? []) {
      if (r.status !== "active") continue;
      const key = r.personId ?? r.workerId;
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.values()].sort((a, b) => b.length - a.length || a[0].name.localeCompare(b[0].name));
  }, [rows]);

  if (authLoading) return null;
  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <p className="text-sm text-muted-foreground">Only the agency owner can see this page.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Crew across clients</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone on a Field Services crew, grouped by person. People who work for more than one
          client are listed first.
        </p>
      </div>
      {usage.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">How clients are using it</h2>
          <div className="overflow-x-auto rounded-2xl border bg-card">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Client</th>
                  <th className="p-3">Requests</th>
                  <th className="p-3">Jobs</th>
                  <th className="p-3">Jobs done</th>
                  <th className="p-3">Visits done</th>
                  <th className="p-3">Time entries</th>
                  <th className="p-3">On-site payments</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {usage.map((u) => (
                  <tr key={u.subAccountId}>
                    <td className="p-3 font-medium">{u.name}</td>
                    <td className="p-3">{u.requests}</td>
                    <td className="p-3">{u.jobs}</td>
                    <td className="p-3">{u.jobsDone}</td>
                    <td className="p-3">{u.visitsDone}</td>
                    <td className="p-3">{u.timeEntries}</td>
                    <td className="p-3">{u.payments}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {feedback.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Feedback from clients</h2>
          <ul className="divide-y rounded-2xl border bg-card">
            {feedback.map((f) => (
              <li key={f.id} className="space-y-0.5 p-4 text-sm">
                <p className="font-medium">
                  {f.subAccountName}
                  {f.helpful === true && " · worked for them"}
                  {f.helpful === false && " · did not work for them"}
                </p>
                {f.text && <p className="text-muted-foreground">{f.text}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {error ? (
        <p className="text-sm text-muted-foreground">Couldn&apos;t load the crew list.</p>
      ) : rows === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : people.length === 0 ? (
        <p className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
          No crew yet. Add workers from a client&apos;s Field Services page.
        </p>
      ) : (
        <ul className="divide-y rounded-2xl border bg-card">
          {people.map((group) => (
            <li key={group[0].personId ?? group[0].workerId} className="space-y-1 p-4">
              <p className="text-sm font-medium">
                {group[0].name}
                {group.length > 1 && (
                  <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                    {group.length} clients
                  </span>
                )}
              </p>
              <ul className="space-y-0.5 text-sm text-muted-foreground">
                {group.map((r) => (
                  <li key={r.workerId}>
                    {r.subAccountName || r.subAccountId} · {r.kind}
                    {r.contact ? ` · ${r.contact}` : ""}
                    {r.source === "crew-app"
                      ? ` · crew app: ${PORTAL_LABEL[r.portalStatus ?? "none"] ?? r.portalStatus}`
                      : " · workspace login"}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
