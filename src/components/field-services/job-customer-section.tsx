"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, X } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callApi } from "@/components/field-services/field-ui";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { jobTerms } from "@/lib/field-services/terms";
import { formatMoneyCode, parseDecimalInput, unitToMinor } from "@/lib/field-services/money";
import type { Job } from "@/types/field-services";

interface ApprovalRow {
  id: string;
  status: "pending" | "approved" | "declined" | "cancelled";
  totalMinor: number;
  currency: string;
  note: string;
  respondedBy: string;
  lines: { description: string; quantity: number; unitPriceMinor: number }[];
}

interface DraftLine {
  description: string;
  quantity: string;
  price: string;
}

const STATUS_LABEL: Record<ApprovalRow["status"], string> = {
  pending: "Waiting for the customer",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
};

export function JobCustomerSection({ job }: { job: Job }) {
  const { subAccountId, isAdmin } = useSubAccount();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const base = `/api/sub-accounts/${subAccountId}/field-services/jobs/${job.id}`;
  const [rows, setRows] = useState<ApprovalRow[] | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([{ description: "", quantity: "1", price: "" }]);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = job.status === "closed" || job.status === "cancelled";

  const load = useCallback(async () => {
    const res = await fetch(`${base}/approvals`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) setRows(((await res.json()) as { approvals: ApprovalRow[] }).approvals);
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copyLink() {
    const res = await fetch(`${base}/customer-link`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !data.url) {
      toast.error(data.error ?? "Couldn't get the link.");
      return;
    }
    try {
      await navigator.clipboard.writeText(data.url);
      toast.success(`Link copied. Anyone with it can see this ${terms.job}'s visits.`);
    } catch {
      window.prompt("Copy this link", data.url);
    }
  }

  async function revoke() {
    const ok = await callApi(`${base}/customer-link`, "POST", { action: "revoke" });
    if (ok) toast.success("Old links no longer work. New messages carry the new link.");
  }

  async function send() {
    const parsed = lines.map((l) => ({
      description: l.description.trim(),
      quantity: parseDecimalInput(l.quantity),
      price: parseDecimalInput(l.price),
    }));
    if (parsed.some((l) => !l.description || l.quantity === null || l.quantity <= 0 || l.price === null || l.price < 0)) {
      toast.error("Each line needs a description, a quantity and a price. Use numbers like 12.50.");
      return;
    }
    setBusy(true);
    const res = await callApi<{ delivered: "sms" | "email" | null }>(`${base}/approvals`, "POST", {
      lines: parsed.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: unitToMinor(job.currency, l.price as number),
      })),
      note,
    });
    setBusy(false);
    if (!res) return;
    toast.success(
      res.delivered
        ? `Sent to the customer by ${res.delivered === "sms" ? "text" : "email"}.`
        : "Saved, but we couldn't message the customer. Copy the link and send it yourself.",
    );
    setLines([{ description: "", quantity: "1", price: "" }]);
    setNote("");
    setOpen(false);
    await load();
  }

  async function cancel(id: string) {
    const ok = await callApi(`${base}/approvals/${id}`, "DELETE");
    if (ok) await load();
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Customer link and extra work</h3>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void copyLink()}>
            Copy customer link
          </Button>
          {isAdmin && (
            <Button size="sm" variant="ghost" onClick={() => void revoke()}>
              Stop old links
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        The link shows the customer their visits and lets them approve extra work. It goes out
        automatically in booking messages when that is switched on in Settings.
      </p>

      {rows && rows.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm">
          {rows.map((r) => (
            <li key={r.id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {formatMoneyCode(r.currency, r.totalMinor)} · {STATUS_LABEL[r.status]}
                  {r.respondedBy ? ` (${r.respondedBy})` : ""}
                </span>
                {r.status === "pending" && (
                  <Button size="sm" variant="outline" onClick={() => void cancel(r.id)}>
                    Cancel
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {r.lines.map((l) => l.description).join(", ")}
              </p>
            </li>
          ))}
        </ul>
      )}

      {!locked &&
        (open ? (
          <div className="space-y-2 rounded-lg border p-3">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2">
                <Input
                  className="col-span-6 h-9"
                  placeholder="What needs doing"
                  value={l.description}
                  onChange={(e) =>
                    setLines((all) => all.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
                  }
                />
                <Input
                  className="col-span-2 h-9"
                  inputMode="decimal"
                  placeholder="Qty"
                  value={l.quantity}
                  onChange={(e) =>
                    setLines((all) => all.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))
                  }
                />
                <Input
                  className="col-span-3 h-9"
                  inputMode="decimal"
                  placeholder="Price"
                  value={l.price}
                  onChange={(e) =>
                    setLines((all) => all.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))
                  }
                />
                <button
                  className="col-span-1 flex items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label="Remove line"
                  onClick={() => setLines((all) => (all.length > 1 ? all.filter((_, j) => j !== i) : all))}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={lines.length >= 10}
                onClick={() => setLines((all) => [...all, { description: "", quantity: "1", price: "" }])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add a line
              </Button>
            </div>
            <Input
              className="h-9"
              placeholder="A note for the customer (optional)"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void send()}>
                {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Send for approval
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Ask the customer to approve extra work
          </Button>
        ))}
    </section>
  );
}
