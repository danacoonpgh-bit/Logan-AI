"use client";

import { workerTerms, withArticle } from "@/lib/field-services/terms";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ChecklistTemplateView } from "@/lib/server/field-checklists-service";

interface Row {
  id?: string;
  text: string;
  required: boolean;
}

/** The checklist a service starts every visit with, and what must be done before a worker can complete the visit. */
export function ChecklistTemplateDialog({
  open,
  onOpenChange,
  base,
  service,
  template,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  service: { id: string; name: string } | null;
  template: ChecklistTemplateView | null;
  onSaved: (productId: string, template: ChecklistTemplateView | null) => void;
}) {
  const { config } = useFieldConfig();
  const wt = workerTerms(config);
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState("");
  const [requireChecklist, setRequireChecklist] = useState(false);
  const [requireSignature, setRequireSignature] = useState(false);
  const [saving, setSaving] = useState(false);

  // Only reset when the dialog opens for a service, so a late load doesn't wipe edits.
  useEffect(() => {
    if (!open) return;
    setRows((template?.items ?? []).map((i) => ({ ...i })));
    setRequireChecklist(template?.requireChecklist === true);
    setRequireSignature(template?.requireSignature === true);
    setText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, service?.id]);

  function add() {
    const t = text.trim();
    if (!t) return;
    setRows((r) => [...r, { text: t, required: false }]);
    setText("");
  }

  async function save() {
    if (!service) return;
    const pendingText = text.trim();
    const all: Row[] = pendingText ? [...rows, { text: pendingText, required: false }] : rows;
    setSaving(true);
    try {
      const res = await fetch(`${base}/field-services/checklists`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: service.id,
          items: all,
          requireChecklist: requireChecklist && all.some((r) => r.required),
          requireSignature,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        template?: ChecklistTemplateView | null;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "That didn't work.");
        return;
      }
      onSaved(service.id, data.template ?? null);
      toast.success("Checklist saved.");
      onOpenChange(false);
    } catch {
      toast.error("Couldn't reach the server. Check your connection.");
    } finally {
      setSaving(false);
    }
  }

  const anyRequired = rows.some((r) => r.required);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Checklist for {service?.name ?? "this service"}</DialogTitle>
          <DialogDescription>
            Every new visit for a job with this service starts with these items. {wt.Workers} tick them off on site.
            Visits already made keep what they had until you refresh them from the job.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No items yet.</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((r, i) => (
                <li key={r.id ?? `new-${i}`} className="flex items-center gap-2">
                  <Input
                    value={r.text}
                    maxLength={120}
                    onChange={(e) =>
                      setRows((list) => list.map((x, n) => (n === i ? { ...x, text: e.target.value } : x)))
                    }
                    aria-label={`Item ${i + 1}`}
                  />
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                    <Checkbox
                      checked={r.required}
                      onCheckedChange={(v) =>
                        setRows((list) => list.map((x, n) => (n === i ? { ...x, required: v === true } : x)))
                      }
                    />
                    Required
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove item ${i + 1}`}
                    onClick={() => setRows((list) => list.filter((_, n) => n !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <Input
              value={text}
              maxLength={120}
              placeholder="Turn the power off at the board"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              aria-label="New item"
            />
            <Button variant="outline" onClick={add} disabled={!text.trim() || rows.length >= 30}>
              Add
            </Button>
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox
                checked={requireChecklist && anyRequired}
                disabled={!anyRequired}
                onCheckedChange={(v) => setRequireChecklist(v === true)}
              />
              <span>
                {wt.Workers} must tick every required item before they can complete the visit
                {!anyRequired && <span className="block text-xs text-muted-foreground">Mark at least one item Required first.</span>}
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox checked={requireSignature} onCheckedChange={(v) => setRequireSignature(v === true)} />
              <span>
                The customer must confirm the work before {withArticle(wt.worker)} can complete the visit
                <span className="block text-xs text-muted-foreground">
                  The customer types their name on a link we text or email them. The office can always complete a visit.
                </span>
              </span>
            </label>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
