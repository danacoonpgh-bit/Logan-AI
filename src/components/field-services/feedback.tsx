"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, MessageSquare } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFieldData } from "@/components/field-services/field-data";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import { jobTerms } from "@/lib/field-services/terms";

async function send(
  subAccountId: string,
  body: { helpful?: boolean; text?: string; source: "link" | "first_job" },
): Promise<boolean> {
  const res = await fetch(`/api/sub-accounts/${subAccountId}/field-services/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return true;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  toast.error(data.error ?? "That didn't work.");
  return false;
}

export function FeedbackButton() {
  const { subAccountId } = useSubAccount();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const ok = await send(subAccountId, { text, source: "link" });
    setBusy(false);
    if (ok) {
      toast.success("Thanks. That goes straight to your agency.");
      setText("");
      setOpen(false);
    }
  }

  return (
    <>
      <button
        className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted"
        onClick={() => setOpen(true)}
      >
        <MessageSquare className="h-4 w-4" /> Send feedback
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Tell us how Field Services is going</DialogTitle>
            <DialogDescription>
              What worked, what was missing, what confused you. Your agency reads every note.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            maxLength={2000}
            className="w-full rounded-md border border-input bg-transparent p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy || text.trim().length === 0}>
              {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One question, shown to admins after the first job is finished and never again once answered or skipped. */
export function FirstJobPrompt() {
  const { subAccountId, isAdmin } = useSubAccount();
  const { jobs } = useFieldData();
  const { config } = useFieldConfig();
  const terms = jobTerms(config);
  const [answered, setAnswered] = useState<boolean | null>(null);
  const [skipped, setSkipped] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(`field-feedback-skipped:${subAccountId}`)) setSkipped(true);
    } catch {}
  }, [subAccountId]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const hasFinishedJob = jobs.some((j) => j.status === "ready_to_invoice" || j.status === "closed");

  useEffect(() => {
    if (!isAdmin || !hasFinishedJob || answered !== null) return;
    void fetch(`/api/sub-accounts/${subAccountId}/field-services/feedback`, { cache: "no-store" })
      .then(async (res) => {
        if (res.ok) setAnswered(((await res.json()) as { answered: boolean }).answered);
      })
      .catch(() => {});
  }, [isAdmin, hasFinishedJob, answered, subAccountId]);

  if (!isAdmin || !hasFinishedJob || answered !== false || skipped) return null;

  async function answer(helpful: boolean) {
    setBusy(true);
    const ok = await send(subAccountId, { helpful, text, source: "first_job" });
    setBusy(false);
    if (ok) {
      setAnswered(true);
      toast.success("Thanks for telling us.");
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border bg-card p-5">
      <h2 className="text-base font-semibold">You finished your first {terms.job}. Did this work for you?</h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="What was missing? (optional)"
        className="w-full rounded-md border border-input bg-transparent p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void answer(true)}>
          Yes, it did
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void answer(false)}>
          Not really
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => {
            try {
              localStorage.setItem(`field-feedback-skipped:${subAccountId}`, "1");
            } catch {}
            setSkipped(true);
          }}>
          Not now
        </Button>
      </div>
    </section>
  );
}
