import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback } from "@/lib/automations/qstash";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import {
  sendSmsForSubAccount,
  sendWhatsappTemplateForSubAccount,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  subAccountWhatsappIsConfigured,
} from "@/lib/comms/twilio";
import {
  DEFAULT_VISIT_MESSAGE_BODY,
  DEFAULT_VISIT_MESSAGE_SUBJECT,
  renderVisitMessage,
  type VisitMessageChannel,
  type VisitMessageKind,
  type VisitMessageTag,
} from "@/lib/field-services/visit-messages";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";
import { formatInZone, utcToZonedInput, zonedTimeToUtc } from "@/lib/field-services/time";
import { jobStatusUrl } from "@/lib/field-services/job-status-token";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { jobTerms } from "@/lib/field-services/terms";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { Contact } from "@/types/contacts";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";
import type { FieldServicesConfig, Job, Visit } from "@/types/field-services";

export type { VisitMessageKind };

const REMINDER_LEAD_MS = 24 * 3_600_000;

function firstName(name: string): string {
  const t = (name ?? "").trim();
  return t ? t.split(/\s+/)[0] : "there";
}

async function singleService(job: Job): Promise<Pick<Product, "customerMessages"> | null> {
  const ids = [...new Set(job.lineItems.map((l) => l.productId).filter((id): id is string => !!id))];
  if (ids.length === 0 || ids.length > 20) return null;
  const db = getAdminDb();
  const docs = await db.getAll(...ids.map((id) => db.doc(`products/${id}`)));
  const services = docs.filter((d) => d.exists && d.data()?.subAccountId === job.subAccountId && d.data()?.kind === "service");
  return services.length === 1 ? (services[0].data() as Pick<Product, "customerMessages">) : null;
}

export async function sendVisitMessage(kind: VisitMessageKind, visitId: string): Promise<void> {
  try {
    const db = getAdminDb();
    const vSnap = await db.doc(`visits/${visitId}`).get();
    if (!vSnap.exists) return;
    const visit = { id: vSnap.id, ...vSnap.data() } as Visit;
    const config = await getFieldServicesConfig(visit.subAccountId);

    const [subSnap, jobSnap, contactSnap] = await Promise.all([
      db.doc(`subAccounts/${visit.subAccountId}`).get(),
      db.doc(`jobs/${visit.jobId}`).get(),
      db.doc(`contacts/${visit.contactId}`).get(),
    ]);
    const sub = subSnap.data() as SubAccountDoc | undefined;
    const job = jobSnap.data() as Job | undefined;
    if (!sub || !fieldServicesAvailable(sub) || !job) return;
    if (!contactSnap.exists) return;
    const contact = { id: contactSnap.id, ...contactSnap.data() } as Contact;
    if (job.status === "cancelled") return;

    // Messages belong to the service. A project with no service, or with more than one, sends none.
    const service = await singleService(job);
    const setting = service?.customerMessages?.[kind];
    if (!setting || setting.enabled !== true) return;

    const start = (visit.scheduledStart as { toDate?: () => Date } | null)?.toDate?.();
    const when = start
      ? formatInZone(start, job.timezone, {
          weekday: "long",
          day: "numeric",
          month: "long",
          hour: "numeric",
          minute: "2-digit",
        })
      : "the scheduled time";
    const template = setting?.body || DEFAULT_VISIT_MESSAGE_BODY[kind];
    const subjectTemplate = setting?.subject || DEFAULT_VISIT_MESSAGE_SUBJECT;
    const needsWorker =
      kind === "on_my_way" ||
      kind === "reminder" ||
      /\{\{\s*(worker|who)\s*\}\}/.test(`${template} ${subjectTemplate}`) ||
      (setting?.whatsappTags ?? []).some((t) => t === "worker" || t === "who");
    let worker = "";
    if (needsWorker && visit.workerIds.length > 0) {
      // A crew of several is named together, such as Sam & Alex.
      const docs = await Promise.all(visit.workerIds.slice(0, 5).map((id) => db.doc(`fieldWorkers/${id}`).get()));
      worker = docs
        .map((d) => (d.data()?.name as string | undefined) ?? "")
        .filter(Boolean)
        .join(" & ");
    }
    const business = sub.name || "our team";
    const link =
      config.statusLinkInMessages === false ? "" : (jobStatusUrl(visit.jobId, job.statusTokenVersion ?? 1) ?? "");
    const values: Record<VisitMessageTag, string> = {
      firstName: firstName(contact.name),
      business,
      title: job.title,
      when,
      worker,
      who: worker ? `${worker} from ${business}` : business,
      link,
    };
    let body = renderVisitMessage(template, values);
    // The standard wording gets the link added at the end; custom wording places it with the link tag.
    if (!/\{\{\s*link\s*\}\}/.test(template)) {
      body = withStatusLink(body, config, visit.jobId, job.statusTokenVersion ?? 1);
    }
    const subject = renderVisitMessage(subjectTemplate, { ...values, business: sub.name || "Your visit" });

    const common = {
      sub,
      contact,
      body,
      subject,
      agencyId: visit.agencyId,
      subAccountId: visit.subAccountId,
      label: `Visit ${kind.replace("_", " ")}`,
      meta: { visitId: visit.id, jobId: visit.jobId },
    };
    if (setting?.channel === "whatsapp" && (await sendVisitWhatsapp({ ...common, setting, values }))) return;
    await deliverToContact({
      ...common,
      channel:
        setting?.channel === "sms" || setting?.channel === "email" || setting?.channel === "sms_first" ? setting.channel : "auto",
    });
  } catch (err) {
    console.warn(`[field-messages] ${kind} message failed`, err);
  }
}

export function withStatusLink(
  body: string,
  config: FieldServicesConfig,
  jobId: string,
  version: number,
): string {
  if (config.statusLinkInMessages === false) return body;
  const url = jobStatusUrl(jobId, version);
  return url ? `${body} Track your ${jobTerms(config).job}: ${url}` : body;
}

/** Emails the contact, or texts them first or only when asked. Records what was sent. */
export async function deliverToContact(input: {
  sub: SubAccountDoc;
  contact: Contact;
  body: string;
  subject: string;
  agencyId: string;
  subAccountId: string;
  label: string;
  meta: Record<string, string>;
  /** Email only, text only or text first. Anything else emails first and falls back to a text. */
  channel?: Exclude<VisitMessageChannel, "whatsapp">;
}): Promise<"sms" | "email" | null> {
  const { sub, contact, body } = input;
  const db = getAdminDb();
  const mode = input.channel ?? "auto";
  const sendText = async (): Promise<"sms" | null> => {
    const canText =
      mode !== "email" &&
      !!contact.phone &&
      smsSendBlock(contact) === null &&
      (subAccountTwilioIsConfigured(sub.twilioConfig) || smsIsConfigured());
    let res: Awaited<ReturnType<typeof sendSmsForSubAccount>> | null = null;
    if (canText) {
      try {
        res = await sendSmsForSubAccount({
          subAccountId: input.subAccountId,
          subAccount: sub,
          to: contact.phone,
          body,
        });
      } catch (err) {
        // A bad number should not also stop the email.
        console.warn("[field-messages] text failed", err);
        if (mode === "sms") throw err;
      }
    }
    if (res) {
      if (res.mode === "dedicated") {
        await db
          .collection("contacts")
          .doc(contact.id)
          .collection("messages")
          .doc(res.sid)
          .set({
            agencyId: input.agencyId,
            subAccountId: input.subAccountId,
            contactId: contact.id,
            direction: "outbound",
            status: "sent",
            body,
            from: res.from,
            to: contact.phone,
            twilioMessageSid: res.sid,
            sentByUid: "field-services",
            error: null,
            readAt: null,
            createdAt: FieldValue.serverTimestamp(),
          })
          .catch(() => {});
        await upsertConversationForMessage({
          contactId: contact.id,
          subAccountId: input.subAccountId,
          agencyId: input.agencyId,
          contactName: contact.name ?? "",
          contactPhone: contact.phone,
          channel: "sms",
          direction: "outbound",
          body,
        }).catch(() => {});
      }
      await logSent(contact.id, "sms_sent", `${input.label} text sent.`, input.meta);
      return "sms";
    }

    return null;
  };
  const sendMail = async (): Promise<"email" | null> => {
    if (mode !== "sms" && contact.email && !contact.emailOptedOut && !contact.emailBouncedAt && emailIsConfigured()) {
      await sendEmail({
        to: contact.email,
        subject: input.subject,
        text: body,
        replyTo: sub.replyToEmail ?? undefined,
        from: tenantFrom(sub),
        meter: { subAccountId: input.subAccountId },
      });
      await logSent(contact.id, "email_sent", `${input.label} email sent.`, input.meta);
      return "email";
    }

    return null;
  };
  // Email first unless the setting says to text first.
  const first = mode === "sms" || mode === "sms_first" ? sendText : sendMail;
  const second = mode === "sms" || mode === "email" ? null : mode === "sms_first" ? sendMail : sendText;
  const done = await first();
  if (done) return done;
  return second ? await second() : null;
}

/** Sends the chosen approved WhatsApp template. False means nothing was sent and the caller should fall back. */
async function sendVisitWhatsapp(input: {
  sub: SubAccountDoc;
  contact: Contact;
  agencyId: string;
  subAccountId: string;
  label: string;
  meta: Record<string, string>;
  setting: { whatsappTemplateId: string; whatsappTags: VisitMessageTag[] };
  values: Record<VisitMessageTag, string>;
}): Promise<boolean> {
  const { sub, contact, setting } = input;
  try {
    if (
      sub.whatsappEnabledByAgency !== true ||
      !subAccountWhatsappIsConfigured(sub.twilioConfig) ||
      !contact.phone ||
      contact.whatsappOptedOut ||
      !setting.whatsappTemplateId
    ) {
      return false;
    }
    const db = getAdminDb();
    const tplSnap = await db
      .doc(`subAccounts/${input.subAccountId}/whatsappTemplates/${setting.whatsappTemplateId}`)
      .get();
    const tpl = tplSnap.data() as WhatsappTemplateDoc | undefined;
    if (!tpl || tpl.status !== "approved" || !tpl.contentSid) return false;
    const vars = [...tpl.variables]
      .sort((a, b) => a.position - b.position)
      .map((v) => input.values[setting.whatsappTags[v.position - 1]] ?? "");
    // Twilio rejects an empty variable, so a missing value means this message goes another way.
    if (vars.some((v) => v.trim() === "")) return false;
    const res = await sendWhatsappTemplateForSubAccount({
      subAccountId: input.subAccountId,
      subAccount: input.sub,
      to: contact.phone,
      contentSid: tpl.contentSid,
      contentVariables: vars,
    });
    const rendered = (tpl.body ?? "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => vars[Number(n) - 1] ?? "");
    await db
      .collection("contacts")
      .doc(contact.id)
      .collection("whatsappMessages")
      .doc(res.sid)
      .set({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        contactId: contact.id,
        direction: "outbound",
        status: "sent",
        body: rendered,
        from: res.from,
        to: contact.phone,
        twilioMessageSid: res.sid,
        sentByUid: "field-services",
        error: null,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});
    await db
      .collection("contacts")
      .doc(contact.id)
      .collection("activities")
      .add({
        type: "whatsapp_sent",
        content: `${input.label} WhatsApp sent.`,
        createdBy: "field-services",
        meta: { ...input.meta, sid: res.sid },
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});
    return true;
  } catch (err) {
    console.warn("[field-messages] whatsapp send failed", err);
    return false;
  }
}

async function logSent(
  contactId: string,
  type: "sms_sent" | "email_sent",
  content: string,
  meta: Record<string, string>,
) {
  await getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection("activities")
    .add({
      type,
      content,
      createdBy: "field-services",
      meta,
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch(() => {});
}

export function reminderTime(start: Date, timeZone: string): Date {
  const target = new Date(start.getTime() - REMINDER_LEAD_MS);
  try {
    const local = utcToZonedInput(target, timeZone);
    const hour = Number(local.slice(11, 13));
    if (hour < 8 || hour >= 20) {
      const clamped = zonedTimeToUtc(`${local.slice(0, 10)}T${hour >= 20 ? "19:30" : "08:00"}`, timeZone);
      if (clamped.getTime() < start.getTime() - 2 * 3_600_000) return clamped;
    }
  } catch {
  }
  return target;
}

export async function scheduleVisitReminder(visit: {
  id: string;
  scheduledStart: Date;
  reminderVersion: number;
  timezone: string;
}): Promise<void> {
  const at = reminderTime(visit.scheduledStart, visit.timezone);
  const delay = Math.floor((at.getTime() - Date.now()) / 1000);
  if (delay < 30) return;
  await publishCallback({
    pathname: "/api/field-services/reminder/step",
    body: { visitId: visit.id, version: visit.reminderVersion },
    delaySeconds: delay,
    deduplicationId: `field_reminder_${visit.id}_${visit.reminderVersion}`,
  });
}
