"use client";

import { formatMinutes, parseHoursInput } from "@/lib/field-services/hours-input";
import { kindLabelOf } from "@/lib/field-services/time-kinds";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { workerTerms } from "@/lib/field-services/terms";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/components/field-services/field-ui";
import { formatInZone, utcToZonedInput, zonedTimeToUtc } from "@/lib/field-services/time";
import { formatMinor, minorToUnit, unitToMinor } from "@/lib/field-services/money";
import { Checkbox } from "@/components/ui/checkbox";
import type { JobDetail } from "@/lib/server/field-job-detail-service";
import type { FieldWorker, Job } from "@/types/field-services";

function hours(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return "—";
  const mins = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function Badge({ tone, children }: { tone: "muted" | "locked" | "warn"; children: React.ReactNode }) {
  const look =
    tone === "locked"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : tone === "warn"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${look}`}>{children}</span>;
}

export function JobWorkSection({
  job,
  workers,
  isOffice,
  refreshKey,
}: {
  job: Job;
  workers: FieldWorker[];
  isOffice: boolean;
  refreshKey: string;
}) {
  const { subAccountId } = useSubAccount();
  const { config } = useFieldConfig();
  const wt = workerTerms(config);
  const base = `/api/sub-accounts/${subAccountId}/field-services`;
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [startLocal, setStartLocal] = useState("");
  const [hoursText, setHoursText] = useState("");
  const [hoursInitial, setHoursInitial] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [reason, setReason] = useState("");
  const [initial, setInitial] = useState({ start: "", end: "" });
  // Parts: the same records the crew app, invoices and reports read, so a change here shows everywhere.
  const [editingPart, setEditingPart] = useState<string | null>(null);
  const [part, setPart] = useState({ name: "", qty: "", unit: "", price: "", cost: "", billable: true });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/jobs/${job.id}/detail`, { cache: "no-store" });
      if (res.ok) setDetail((await res.json()) as JobDetail);
    } catch {
    }
  }, [base, job.id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 20_000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  const workerName = (id: string) => workers.find((w) => w.id === id)?.name ?? `Removed ${wt.worker}`;

  async function saveEdit(id: string, extra: Record<string, unknown> = {}) {
    const body: Record<string, unknown> = { reason, ...extra };
    if (hoursInitial !== "" && !("voided" in extra) && hoursText.trim() !== hoursInitial) {
      const m = parseHoursInput(hoursText);
      if (m === null || m <= 0) {
        toast.error("Enter the hours, for example 4 or 2:30.");
        return;
      }
      body.durationMinutes = m;
    }
    if (startLocal && startLocal !== initial.start) {
      body.startAt = zonedTimeToUtc(startLocal, job.timezone).toISOString();
    }
    if (endLocal && endLocal !== initial.end) {
      body.endAt = zonedTimeToUtc(endLocal, job.timezone).toISOString();
    }
    const ok = await callApi(`${base}/time-entries/${id}`, "PATCH", body);
    if (ok) {
      toast.success("Time updated.");
      setEditing(null);
      setReason("");
      await load();
    }
  }

  async function savePart(id: string) {
    const qty = Number(part.qty);
    const price = part.price.trim() === "" ? 0 : Number(part.price);
    const cost = part.cost.trim() === "" ? 0 : Number(part.cost);
    if (!part.name.trim()) return void toast.error("Say what the part is.");
    if (!Number.isFinite(qty) || qty <= 0) return void toast.error("Quantity must be more than zero.");
    if (!Number.isFinite(price) || price < 0 || !Number.isFinite(cost) || cost < 0) return void toast.error("Enter the price and cost as numbers.");
    const ok = await callApi(`${base}/materials/${id}`, "PATCH", {
      name: part.name,
      qty,
      unit: part.unit,
      unitPriceMinor: unitToMinor(job.currency, price),
      unitCostMinor: unitToMinor(job.currency, cost),
      billable: part.billable,
    });
    if (ok) {
      toast.success("Part updated.");
      setEditingPart(null);
      await load();
    }
  }

  async function deletePart(id: string) {
    const ok = await callApi(`${base}/materials/${id}`, "DELETE");
    setConfirmDelete(null);
    if (ok) {
      toast.success("Part removed.");
      setEditingPart(null);
      await load();
    }
  }

  async function decide(id: string, decision: "confirm" | "reject") {
    const res = await callApi<{ invoicePaid?: boolean }>(`${base}/payments/${id}`, "POST", { decision });
    if (res) {
      toast.success(
        decision === "reject"
          ? "Payment claim rejected."
          : res.invoicePaid
            ? "Confirmed. The invoice is marked paid."
            : "Confirmed.",
      );
      await load();
    }
  }

  if (!detail) return null;
  const anyData =
    detail.time.length + detail.materials.length + detail.payments.length + detail.photos.length > 0;
  if (!anyData) return null;

  return (
    <section className="space-y-5">
      <h3 className="text-sm font-semibold">Recorded by the {wt.workers}</h3>
      {detail.time.some((e) => e.invoiced) && (
        <p className="-mt-3 text-xs text-muted-foreground">
          Time that is on an invoice is locked so the invoice stays true. To change it, delete the draft invoice (Quotes), then edit here.
        </p>
      )}

      {detail.time.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Time</p>
          <ul className="divide-y rounded-lg border text-sm">
            {detail.time.map((e) => (
              <li key={e.id} className={"space-y-2 p-3 " + (e.voided ? "opacity-50" : "")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {workerName(e.workerId)}
                    {e.kind !== "visit" ? ` (${kindLabelOf(config?.timeKinds, e.kind).toLowerCase()})` : ""} ·{" "}
                    {e.hoursOnly
                      ? e.date
                        ? formatInZone(zonedTimeToUtc(`${e.date}T12:00`, job.timezone), job.timezone, { day: "numeric", month: "short" })
                        : "—"
                      : e.startAt
                        ? formatInZone(new Date(e.startAt), job.timezone, { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" })
                        : "—"}
                    {" · "}
                    {e.hoursOnly ? `${formatMinutes(e.minutes ?? 0)} h` : e.running ? "running" : hours(e.startAt, e.endAt)}
                    {e.voided && <Badge tone="muted">Voided</Badge>}
                    {!e.billable && !e.voided && <Badge tone="muted">Not billed</Badge>}
                    {e.invoiced && <Badge tone="locked">Invoiced · locked</Badge>}
                    {e.running && <Badge tone="muted">Running · edit after it stops</Badge>}
                  </span>
                  {isOffice && !e.running && !e.invoiced && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(editing === e.id ? null : e.id);
                        const s = e.startAt ? utcToZonedInput(new Date(e.startAt), job.timezone) : "";
                        const en = e.endAt ? utcToZonedInput(new Date(e.endAt), job.timezone) : "";
                        setStartLocal(s);
                        setEndLocal(en);
                        setInitial({ start: s, end: en });
                        const hrs = e.hoursOnly ? formatMinutes(e.minutes ?? 0) : "";
                        setHoursText(hrs);
                        setHoursInitial(hrs);
                        setReason("");
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </div>
                {(e.autoClosed || e.correctionNote) && (
                  <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    {e.correctionNote ?? "Stopped automatically after running too long."}
                  </p>
                )}
                {editing === e.id && (
                  <div className="grid gap-2 sm:grid-cols-4">
                    {e.hoursOnly ? (
                      <div className="sm:col-span-2">
                        <Label className="mb-1 block text-xs text-muted-foreground">Hours</Label>
                        <Input value={hoursText} placeholder="4 or 2:30" onChange={(ev) => setHoursText(ev.target.value)} />
                      </div>
                    ) : (
                      <>
                        <div>
                          <Label className="mb-1 block text-xs text-muted-foreground">Start</Label>
                          <Input type="datetime-local" value={startLocal} onChange={(ev) => setStartLocal(ev.target.value)} />
                        </div>
                        <div>
                          <Label className="mb-1 block text-xs text-muted-foreground">End</Label>
                          <Input type="datetime-local" value={endLocal} onChange={(ev) => setEndLocal(ev.target.value)} />
                        </div>
                      </>
                    )}
                    <div className="sm:col-span-2">
                      <Label className="mb-1 block text-xs text-muted-foreground">Why (kept in the history)</Label>
                      <Input value={reason} onChange={(ev) => setReason(ev.target.value)} />
                    </div>
                    <div className="flex flex-wrap gap-2 sm:col-span-4">
                      <Button size="sm" disabled={!reason.trim()} onClick={() => void saveEdit(e.id)}>
                        Save change
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!reason.trim()}
                        onClick={() => void saveEdit(e.id, { voided: !e.voided })}
                      >
                        {e.voided ? "Restore entry" : "Void entry"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!reason.trim()}
                        onClick={() => void saveEdit(e.id, { billable: !e.billable })}
                      >
                        {e.billable ? "Mark not billable" : "Mark billable"}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.materials.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Parts</p>
          <ul className="divide-y rounded-lg border text-sm">
            {detail.materials.map((m) => (
              <li key={m.id} className="space-y-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {m.qty} {m.unit} · {m.name} · {formatMinor(job.currency, m.unitPriceMinor)} each
                    {m.unitPriceMinor <= 0 && m.billable && <Badge tone="warn">No price · not on invoices</Badge>}
                    {!m.billable && <Badge tone="muted">Not billed</Badge>}
                    {m.notInEstimate && <Badge tone="warn">Not in estimate</Badge>}
                    {m.invoiced && <Badge tone="locked">Invoiced · locked</Badge>}
                  </span>
                  {isOffice && !m.invoiced && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (editingPart === m.id) return setEditingPart(null);
                        setEditingPart(m.id);
                        setConfirmDelete(null);
                        setPart({
                          name: m.name,
                          qty: String(m.qty),
                          unit: m.unit,
                          price: m.unitPriceMinor ? String(minorToUnit(job.currency, m.unitPriceMinor)) : "",
                          cost: m.unitCostMinor ? String(minorToUnit(job.currency, m.unitCostMinor)) : "",
                          billable: m.billable,
                        });
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </div>
                {editingPart === m.id && (
                  <div className="grid gap-2 sm:grid-cols-6">
                    <div className="sm:col-span-3">
                      <Label className="mb-1 block text-xs text-muted-foreground">Part</Label>
                      <Input value={part.name} onChange={(ev) => setPart({ ...part, name: ev.target.value })} />
                    </div>
                    <div>
                      <Label className="mb-1 block text-xs text-muted-foreground">Qty</Label>
                      <Input inputMode="decimal" value={part.qty} onChange={(ev) => setPart({ ...part, qty: ev.target.value })} />
                    </div>
                    <div className="sm:col-span-2">
                      <Label className="mb-1 block text-xs text-muted-foreground">Unit</Label>
                      <Input value={part.unit} onChange={(ev) => setPart({ ...part, unit: ev.target.value })} />
                    </div>
                    <div className="sm:col-span-3">
                      <Label className="mb-1 block text-xs text-muted-foreground">Price each (charged to the customer)</Label>
                      <Input inputMode="decimal" value={part.price} onChange={(ev) => setPart({ ...part, price: ev.target.value })} />
                    </div>
                    <div className="sm:col-span-3">
                      <Label className="mb-1 block text-xs text-muted-foreground">Cost each (internal)</Label>
                      <Input inputMode="decimal" value={part.cost} onChange={(ev) => setPart({ ...part, cost: ev.target.value })} />
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 text-sm sm:col-span-6">
                      <Checkbox checked={part.billable} onCheckedChange={(v) => setPart({ ...part, billable: v === true })} />
                      Billable (goes on the next invoice)
                    </label>
                    <div className="flex flex-wrap gap-2 sm:col-span-6">
                      <Button size="sm" onClick={() => void savePart(m.id)}>
                        Save part
                      </Button>
                      {confirmDelete === m.id ? (
                        <Button size="sm" variant="destructive" onClick={() => void deletePart(m.id)}>
                          Yes, remove it
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => setConfirmDelete(m.id)}>
                          Remove part
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {detail.materials.some((m) => m.taxable) && (
            <p className="mt-1 text-xs text-muted-foreground">
              Some parts are marked taxable. Estimates and invoices use one tax rate for the whole
              document, so check the tax line before you send.
            </p>
          )}
        </div>
      )}

      {detail.payments.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Collected on site</p>
          <ul className="divide-y rounded-lg border text-sm">
            {detail.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  {p.method} · {formatMinor(p.currency, p.amountMinor)} ·{" "}
                  <span className={p.status === "pending" ? "text-amber-600 dark:text-amber-400" : ""}>
                    {p.status}
                  </span>
                  {p.note ? ` · ${p.note}` : ""}
                </span>
                {isOffice && p.status === "pending" && (
                  <span className="flex gap-2">
                    <Button size="sm" onClick={() => void decide(p.id, "confirm")}>
                      Confirm
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void decide(p.id, "reject")}>
                      Reject
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.photos.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Photos</p>
          <div className="flex flex-wrap gap-2">
            {detail.photos.map((p) => {
              const url = `${base}/visits/${p.visitId}/photos/${p.id}`;
              return (
                <a key={p.id} href={url} target="_blank" rel="noreferrer" className="block text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`${url}?size=thumb`}
                    alt={`${p.label} photo`}
                    className="h-24 w-24 rounded-lg border object-cover"
                    loading="lazy"
                  />
                  <span className="text-[11px] text-muted-foreground">{p.label}</span>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
