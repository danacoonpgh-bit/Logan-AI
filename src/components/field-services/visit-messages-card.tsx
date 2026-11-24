"use client";

import { workerTerms } from "@/lib/field-services/terms";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SELECT_CLASS } from "@/components/field-services/field-ui";
import { useFieldConfig } from "@/components/field-services/timesheets-ui";
import {
  DEFAULT_VISIT_MESSAGE_BODY,
  DEFAULT_VISIT_MESSAGE_SETTING,
  DEFAULT_VISIT_MESSAGE_SUBJECT,
  MAX_VISIT_MESSAGE_BODY,
  VISIT_MESSAGE_CHANNELS,
  VISIT_MESSAGE_KINDS,
  VISIT_MESSAGE_LABELS,
  VISIT_MESSAGE_TAGS,
  renderVisitMessage,
  sampleVisitValues,
  type ServiceMessageSetting,
  type VisitMessageKind,
  type VisitMessageSetting,
  type VisitMessageTag,
} from "@/lib/field-services/visit-messages";
import type { Product } from "@/types/products";

interface WaTemplate {
  id: string;
  displayName: string;
  body: string;
  status: string;
  variables: { position: number; label: string }[];
}

function KindEditor({
  kind,
  saved,
  enabled,
  whatsappOn,
  templates,
  onSave,
  onToggle,
  fix,
}: {
  kind: VisitMessageKind;
  saved: VisitMessageSetting;
  enabled: boolean;
  whatsappOn: boolean;
  templates: WaTemplate[];
  onSave: (kind: VisitMessageKind, next: VisitMessageSetting) => Promise<boolean>;
  onToggle: (on: boolean) => void;
  /** Applies the workspace's own word for a worker to a tag label. */
  fix: (label: string) => string;
}) {
  const [draft, setDraft] = useState<VisitMessageSetting>(saved);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const label = VISIT_MESSAGE_LABELS[kind];
  const dirty = JSON.stringify({ ...draft, body: draft.body.trim(), subject: draft.subject.trim() }) !== JSON.stringify(saved);
  const body = draft.body || DEFAULT_VISIT_MESSAGE_BODY[kind];
  const subject = draft.subject || DEFAULT_VISIT_MESSAGE_SUBJECT;
  const sample = sampleVisitValues();
  const template = templates.find((t) => t.id === draft.whatsappTemplateId);
  const fieldCount = template ? Math.max(0, ...template.variables.map((v) => v.position)) : 0;
  const unmapped =
    draft.channel === "whatsapp" &&
    template !== undefined &&
    Array.from({ length: fieldCount }).some((_, i) => !draft.whatsappTags[i]);

  function addTag(tag: string) {
    const el = bodyRef.current;
    const at = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? at;
    const next = `${draft.body.slice(0, at)}{{${tag}}}${draft.body.slice(end)}`;
    if (next.length > MAX_VISIT_MESSAGE_BODY) return;
    setDraft((d) => ({ ...d, body: next }));
    requestAnimationFrame(() => {
      const pos = at + tag.length + 4;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  async function save() {
    setBusy(true);
    const ok = await onSave(kind, draft);
    setBusy(false);
    if (ok) toast.success(`${label.title} message saved.`);
  }

  return (
    <div className="rounded-xl border p-4">
      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <Checkbox checked={enabled} onCheckedChange={(v) => onToggle(v === true)} />
        {label.title}
      </label>

      {enabled && (
        <div className="mt-4 space-y-4">
          <div className="sm:max-w-xs">
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">Send by</Label>
            <select
              className={SELECT_CLASS}
              value={draft.channel}
              onChange={(e) => setDraft((d) => ({ ...d, channel: e.target.value as VisitMessageSetting["channel"] }))}
            >
              {VISIT_MESSAGE_CHANNELS.filter((c) => c.id !== "whatsapp" || whatsappOn).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {VISIT_MESSAGE_CHANNELS.find((c) => c.id === draft.channel)?.hint}
            </p>
          </div>

          {draft.channel === "whatsapp" ? (
            <div className="space-y-3">
              <div className="sm:max-w-md">
                <Label className="mb-1 block text-xs font-medium text-muted-foreground">Approved WhatsApp template</Label>
                <select
                  className={SELECT_CLASS}
                  value={draft.whatsappTemplateId}
                  onChange={(e) => setDraft((d) => ({ ...d, whatsappTemplateId: e.target.value, whatsappTags: [] }))}
                >
                  <option value="">Choose a template</option>
                  {templates
                    .filter((t) => t.status === "approved")
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.displayName}
                      </option>
                    ))}
                </select>
                {templates.every((t) => t.status !== "approved") && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    No approved template yet. Create one under AI Agents, WhatsApp, Templates.
                  </p>
                )}
              </div>
              {template && (
                <>
                  <p className="rounded-lg bg-muted/50 p-3 text-sm">{template.body}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {[...template.variables]
                      .sort((a, b) => a.position - b.position)
                      .map((v) => (
                        <div key={v.position}>
                          <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                            {`{{${v.position}}}`} {v.label}
                          </Label>
                          <select
                            className={SELECT_CLASS}
                            value={draft.whatsappTags[v.position - 1] ?? ""}
                            onChange={(e) =>
                              setDraft((d) => {
                                const tags = Array.from(
                                  { length: fieldCount },
                                  (_, i) => d.whatsappTags[i] ?? "",
                                ) as VisitMessageTag[];
                                tags[v.position - 1] = e.target.value as VisitMessageTag;
                                return { ...d, whatsappTags: tags };
                              })
                            }
                          >
                            <option value="">Fill with…</option>
                            {VISIT_MESSAGE_TAGS.map((t) => (
                              <option key={t.tag} value={t.tag}>
                                {fix(t.label)}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                  </div>
                  {unmapped && <p className="text-xs text-destructive">Choose what fills every field before saving.</p>}
                  <p className="text-xs text-muted-foreground">
                    If WhatsApp can&apos;t be used for a customer, the message below goes by text, else email.
                  </p>
                </>
              )}
            </div>
          ) : null}

          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              {draft.channel === "whatsapp" ? "Text and email wording" : "Message"}
            </Label>
            <Textarea
              ref={bodyRef}
              rows={3}
              maxLength={MAX_VISIT_MESSAGE_BODY}
              value={draft.body}
              placeholder={DEFAULT_VISIT_MESSAGE_BODY[kind]}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {VISIT_MESSAGE_TAGS.map((t) => (
                <button
                  key={t.tag}
                  type="button"
                  onClick={() => addTag(t.tag)}
                  className="rounded-full border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  {fix(t.label)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Leave it empty for the standard wording. The status page link is added at the end unless you place it with the
              Status page link tag.
            </p>
          </div>

          {draft.channel !== "sms" && (
            <div className="sm:max-w-md">
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">Email subject</Label>
              <Input
                value={draft.subject}
                maxLength={120}
                placeholder={DEFAULT_VISIT_MESSAGE_SUBJECT}
                onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
              />
            </div>
          )}

          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <p className="text-xs font-medium text-muted-foreground">Preview</p>
            {draft.channel !== "sms" && (
              <p className="mt-1 text-xs text-muted-foreground">Subject: {renderVisitMessage(subject, sample)}</p>
            )}
            <p className="mt-1 whitespace-pre-wrap">{renderVisitMessage(body, sample)}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !dirty || unmapped} onClick={() => void save()}>
              {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || JSON.stringify(draft) === JSON.stringify(DEFAULT_VISIT_MESSAGE_SETTING)}
              onClick={() => setDraft(DEFAULT_VISIT_MESSAGE_SETTING)}
            >
              Standard wording
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function settingOf(m: Partial<ServiceMessageSetting> | undefined): VisitMessageSetting {
  return {
    channel: m?.channel ?? "auto",
    body: m?.body ?? "",
    subject: m?.subject ?? "",
    whatsappTemplateId: m?.whatsappTemplateId ?? "",
    whatsappTags: m?.whatsappTags ?? [],
  };
}

/** One service's customer messages: which are on, the channel and the wording. Saves each change straight away. */
export function ServiceMessages({
  subAccountId,
  productId,
  messages,
}: {
  subAccountId: string;
  productId: string;
  messages: Product["customerMessages"];
}) {
  const { subAccount } = useSubAccount();
  const { config } = useFieldConfig();
  const whatsappOn = subAccount?.whatsappEnabledByAgency === true;
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [flags, setFlags] = useState<Partial<Record<VisitMessageKind, boolean>>>({});
  const url = `/api/sub-accounts/${subAccountId}/field-services/service-messages/${productId}`;

  useEffect(() => {
    if (!whatsappOn) return;
    let cancelled = false;
    fetch(`/api/sub-accounts/${subAccountId}/whatsapp-templates`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { templates?: WaTemplate[] } | null) => {
        if (!cancelled && d?.templates) setTemplates(d.templates);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [subAccountId, whatsappOn]);

  async function send(body: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) return true;
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(data.error ?? "That didn't save.");
    } catch {
      toast.error("No connection. Try again.");
    }
    return false;
  }

  async function toggle(kind: VisitMessageKind, on: boolean) {
    setFlags((f) => ({ ...f, [kind]: on }));
    const ok = await send({ kind, enabled: on });
    if (!ok) setFlags((f) => ({ ...f, [kind]: undefined }));
  }

  const fix = (l: string) => l.replace(/^Worker/, workerTerms(config).Worker);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        What customers are told about visits for this service, in which words and by which channel. Opt-outs are always respected.
        These apply to a project that has just this one service. A project with no service, or with more than one, sends none.
      </p>
      {VISIT_MESSAGE_KINDS.map((kind) => (
        <KindEditor
          key={kind}
          kind={kind}
          saved={settingOf(messages?.[kind])}
          enabled={flags[kind] ?? messages?.[kind]?.enabled === true}
          whatsappOn={whatsappOn}
          templates={templates}
          onSave={(k, next) => send({ kind: k, setting: next })}
          onToggle={(on) => void toggle(kind, on)}
          fix={fix}
        />
      ))}
    </div>
  );
}
