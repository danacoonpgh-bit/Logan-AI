export type VisitMessageKind = "scheduled" | "reminder" | "on_my_way" | "completed";

export const VISIT_MESSAGE_KINDS: VisitMessageKind[] = ["scheduled", "reminder", "on_my_way", "completed"];

export type VisitMessageChannel = "auto" | "sms_first" | "sms" | "email" | "whatsapp";

export const VISIT_MESSAGE_CHANNELS: { id: VisitMessageChannel; label: string; hint: string }[] = [
  { id: "auto", label: "Email, else text", hint: "Emails the customer. Texts only when they have no email that can be used." },
  { id: "sms_first", label: "Text, else email", hint: "Texts customers who can be texted, otherwise emails them." },
  { id: "sms", label: "Text only", hint: "Customers who can't be texted get nothing." },
  { id: "email", label: "Email only", hint: "Always email, never text." },
  { id: "whatsapp", label: "WhatsApp", hint: "Sends your approved WhatsApp template. If it can't be sent, falls back to text, else email." },
];

export const VISIT_MESSAGE_TAGS = [
  { tag: "firstName", label: "First name", sample: "Sam" },
  { tag: "business", label: "Business name", sample: "Acme Plumbing" },
  { tag: "title", label: "Job title", sample: "Boiler service" },
  { tag: "when", label: "Date and time", sample: "Tuesday, 4 March, 9:30 am" },
  { tag: "worker", label: "Worker's name", sample: "Alex" },
  { tag: "who", label: "Worker from business", sample: "Alex from Acme Plumbing" },
  { tag: "link", label: "Status page link", sample: "https://example.com/j/abc" },
] as const;

export type VisitMessageTag = (typeof VISIT_MESSAGE_TAGS)[number]["tag"];

const TAG_IDS: string[] = VISIT_MESSAGE_TAGS.map((t) => t.tag);

export interface VisitMessageSetting {
  channel: VisitMessageChannel;
  /** Empty means the standard wording. */
  body: string;
  /** Email subject. Empty means the standard subject. */
  subject: string;
  whatsappTemplateId: string;
  /** For each {{n}} of the WhatsApp template, the tag that fills it. */
  whatsappTags: VisitMessageTag[];
}

export const DEFAULT_VISIT_MESSAGE_SETTING: VisitMessageSetting = {
  channel: "auto",
  body: "",
  subject: "",
  whatsappTemplateId: "",
  whatsappTags: [],
};

export const MAX_VISIT_MESSAGE_BODY = 600;
export const MAX_VISIT_MESSAGE_SUBJECT = 120;

export const DEFAULT_VISIT_MESSAGE_BODY: Record<VisitMessageKind, string> = {
  scheduled: `Hi {{firstName}}, {{business}} has booked your visit for "{{title}}" on {{when}}.`,
  reminder: `Hi {{firstName}}, a reminder that {{who}} is visiting for "{{title}}" on {{when}}.`,
  on_my_way: `Hi {{firstName}}, {{who}} is on the way to you now for "{{title}}".`,
  completed: `Hi {{firstName}}, your visit for "{{title}}" is done. Thanks for choosing {{business}}.`,
};

export const DEFAULT_VISIT_MESSAGE_SUBJECT = "{{business}}: {{title}}";

export const VISIT_MESSAGE_LABELS: Record<VisitMessageKind, { toggle: string; title: string }> = {
  scheduled: { toggle: "notifyScheduled", title: "Visit booked" },
  reminder: { toggle: "notifyReminder", title: "Day-before reminder" },
  on_my_way: { toggle: "notifyOnMyWay", title: "Worker on the way" },
  completed: { toggle: "notifyCompleted", title: "Visit done" },
};

const TAG_RE = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

const ANY_TAG_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Tags in the text that aren't one we fill in, including malformed ones. */
export function unknownVisitTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ANY_TAG_RE)) if (!TAG_IDS.includes(m[1])) out.add(m[1]);
  return [...out];
}

export function isVisitMessageTag(v: unknown): v is VisitMessageTag {
  return typeof v === "string" && TAG_IDS.includes(v);
}

export function renderVisitMessage(text: string, values: Partial<Record<VisitMessageTag, string>>): string {
  return text
    .replace(TAG_RE, (_m, tag: string) => values[tag as VisitMessageTag] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function sampleVisitValues(): Record<VisitMessageTag, string> {
  const out = {} as Record<VisitMessageTag, string>;
  for (const t of VISIT_MESSAGE_TAGS) out[t.tag] = t.sample;
  return out;
}

export function cleanVisitMessageSetting(raw: unknown): VisitMessageSetting | string {
  const v = (raw ?? {}) as Record<string, unknown>;
  const channel = v.channel ?? "auto";
  if (!VISIT_MESSAGE_CHANNELS.some((c) => c.id === channel)) return "Choose how the message is sent.";
  const body = typeof v.body === "string" ? v.body.trim() : "";
  const subject = typeof v.subject === "string" ? v.subject.trim() : "";
  if (body.length > MAX_VISIT_MESSAGE_BODY) return `Keep the message under ${MAX_VISIT_MESSAGE_BODY} characters.`;
  if (subject.length > MAX_VISIT_MESSAGE_SUBJECT) return `Keep the subject under ${MAX_VISIT_MESSAGE_SUBJECT} characters.`;
  const bad = [...unknownVisitTags(body), ...unknownVisitTags(subject)];
  if (bad.length > 0) return `Unknown tag: {{${bad[0]}}}. Use the tags listed under the message.`;
  const templateId = typeof v.whatsappTemplateId === "string" ? v.whatsappTemplateId.trim() : "";
  if (templateId && !/^[A-Za-z0-9_-]{4,128}$/.test(templateId)) return "Choose the WhatsApp template from the list.";
  const tags = Array.isArray(v.whatsappTags) ? v.whatsappTags : [];
  if (tags.length > 10 || tags.some((t) => !isVisitMessageTag(t))) return "Choose what fills each WhatsApp field.";
  if (channel === "whatsapp" && !templateId) return "Choose a WhatsApp template, or pick another way to send.";
  return {
    channel: channel as VisitMessageChannel,
    body,
    subject,
    whatsappTemplateId: templateId,
    whatsappTags: tags as VisitMessageTag[],
  };
}

/** A service's setting for one customer message: on or off, plus the wording and channel. */
export type ServiceMessageSetting = VisitMessageSetting & { enabled: boolean };
