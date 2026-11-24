import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatInZone } from "@/lib/field-services/time";
import { sendPushToUser } from "@/lib/push/send";
import { sendPushToFieldPerson } from "@/lib/push/send-field-person";
import { sendEmail, tenantFrom, emailIsConfigured } from "@/lib/comms/resend";
import { hitLimit } from "@/lib/server/field-rate-limit";
import { getFieldServicesConfig, getJobTerms } from "@/lib/server/field-services-config-service";
import { sendPortalSms } from "@/lib/server/field-portal-sms";
import { SmsRecipientUnsubscribedError } from "@/lib/comms/twilio";
import type { SubAccountDoc } from "@/types";

export type CrewNoticeKind = "assigned" | "rescheduled" | "cancelled" | "unassigned" | "updated";

const HEADLINE: Record<CrewNoticeKind, string> = {
  assigned: "New visit",
  rescheduled: "Visit moved",
  cancelled: "Visit cancelled",
  unassigned: "Visit removed from you",
  updated: "Visit details changed",
};

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
}

async function fallback(input: {
  personId: string;
  subAccountId: string;
  sub: SubAccountDoc;
  text: string;
  /** The staff record's own number, used only when the workspace asks for texts first. */
  phone?: string;
}): Promise<void> {
  const person = (await getAdminDb().doc(`fieldPersons/${input.personId}`).get()).data();
  if (!person || person.status !== "active") return;
  const cap = await hitLimit(`crew:fallback:${input.personId}`, 12, 24 * 3_600_000);
  if (!cap.ok) return;
  const body = `${input.text} Open: ${appUrl()}/field/${input.subAccountId}`;
  const phone = (typeof person.phone === "string" && person.phone) || input.phone || "";

  const sendText = async (): Promise<boolean> => {
    if (!phone || person.smsBlocked === true) return false;
    try {
      await sendPortalSms({ subAccountId: input.subAccountId, sub: input.sub, to: phone, body, bucket: "alerts" });
      return true;
    } catch (err) {
      if (err instanceof SmsRecipientUnsubscribedError) {
        await getAdminDb().doc(`fieldPersons/${input.personId}`).update({ smsBlocked: true });
      } else {
        console.warn("[crew-notify] text failed", err);
      }
      return false;
    }
  };
  const sendMail = async (): Promise<boolean> => {
    if (!person.email || !emailIsConfigured()) return false;
    await sendEmail({
      to: person.email as string,
      subject: input.text,
      text: body,
      from: tenantFrom(input.sub),
      subAccount: input.sub,
    });
    return true;
  };

  const textFirst = (await getFieldServicesConfig(input.subAccountId)).crewAlertChannel === "sms";
  if (textFirst) {
    if (!(await sendText())) await sendMail();
  } else if (!(await sendMail())) {
    await sendText();
  }
}

/** Tells the affected crew about a visit change. Push first; a text or email only if no device took it. */
export async function notifyCrew(input: {
  visitId: string;
  workerIds: string[];
  kind: CrewNoticeKind;
  /** What changed, for an "updated" notice. */
  detail?: string;
}): Promise<void> {
  if (input.workerIds.length === 0) return;
  try {
    const db = getAdminDb();
    const visitSnap = await db.doc(`visits/${input.visitId}`).get();
    const visit = visitSnap.data();
    if (!visit) return;
    const [jobSnap, subSnap, workerSnaps, terms] = await Promise.all([
      db.doc(`jobs/${visit.jobId}`).get(),
      db.doc(`subAccounts/${visit.subAccountId}`).get(),
      Promise.all(input.workerIds.map((id) => db.doc(`fieldWorkers/${id}`).get())),
      getJobTerms(visit.subAccountId),
    ]);
    const sub = subSnap.data() as SubAccountDoc | undefined;
    if (!sub || !fieldServicesAvailable(sub)) return;
    const tz = (jobSnap.data()?.timezone as string | undefined) ?? "UTC";
    const start = (visit.scheduledStart as Timestamp | null)?.toDate?.();
    const when = start
      ? formatInZone(start, tz, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
      : "";
    const title = HEADLINE[input.kind];
    const label = `${visit.jobTitle || terms.Job}${visit.address ? `, ${visit.address}` : ""}`;
    const body = [input.detail, label, when].filter(Boolean).join(" · ");

    for (const w of workerSnaps) {
      const worker = w.data();
      if (!worker || worker.subAccountId !== visit.subAccountId || worker.status !== "active") continue;
      // A shared tag would swap the new alert in over the old one silently, with no sound.
      const tag = `visit-${input.visitId}-${input.kind}-${Date.now().toString(36)}`;
      // A member who has the crew app on gets that alert instead of a second one from the workspace.
      const delivered =
        worker.personId && worker.portalStatus === "active"
          ? await sendPushToFieldPerson({
              personId: worker.personId as string,
              title,
              body,
              url: `/field/${visit.subAccountId}`,
              tag,
            })
          : -1;
      if (worker.memberUid && delivered <= 0) {
        await sendPushToUser({
          uid: worker.memberUid as string,
          title,
          body,
          url: `/sa/${visit.subAccountId}/field-services/today`,
          tag,
        });
      }
      if (delivered === 0 && !worker.memberUid) {
        await fallback({
          personId: worker.personId as string,
          subAccountId: visit.subAccountId as string,
          sub,
          phone: typeof worker.phone === "string" ? worker.phone : "",
          text: `${title}: ${body}.`,
        }).catch((err) => console.warn("[crew-notify] fallback failed", err));
      }
    }
  } catch (err) {
    console.warn("[crew-notify] failed", err);
  }
}

/**
 * Tells the crew on a project's coming visits that something about it changed (address, notes, details).
 * One notice per person, on their soonest visit, so a repeating project never sends a stack of them.
 */
export async function notifyCrewOfJobChange(input: { jobId: string; detail: string; exceptWorkerId?: string | null }): Promise<void> {
  try {
    const now = Date.now();
    const snap = await getAdminDb().collection("visits").where("jobId", "==", input.jobId).get();
    const perWorker = new Map<string, { visitId: string; start: number; count: number }>();
    for (const d of snap.docs) {
      const v = d.data();
      if (["completed", "no_show", "cancelled"].includes(v.status)) continue;
      const start = (v.scheduledStart as Timestamp | null)?.toMillis?.() ?? null;
      // A repeating project has weeks of visits; only the coming fortnight matters to a person today.
      if (start === null || start < now - 4 * 3_600_000 || start > now + 14 * 86_400_000) continue;
      for (const w of (v.workerIds as string[] | undefined) ?? []) {
        if (w === input.exceptWorkerId) continue;
        const cur = perWorker.get(w);
        if (!cur) perWorker.set(w, { visitId: d.id, start, count: 1 });
        else perWorker.set(w, { visitId: start < cur.start ? d.id : cur.visitId, start: Math.min(start, cur.start), count: cur.count + 1 });
      }
    }
    for (const [workerId, hit] of perWorker) {
      const more = hit.count > 1 ? ` (and ${hit.count - 1} more visit${hit.count === 2 ? "" : "s"})` : "";
      await notifyCrew({ visitId: hit.visitId, workerIds: [workerId], kind: "updated", detail: input.detail + more });
    }
  } catch (err) {
    console.warn("[crew-notify] job change failed", err);
  }
}
