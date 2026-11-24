import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendPushForEvent } from "@/lib/push/send";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { closeStaleTimers } from "@/lib/server/field-time-service";
import { refreshInvoicedFlag } from "@/lib/server/field-invoicing";
import { sendTimesheetReminders } from "@/lib/server/field-timesheet-reminder-service";
import type { Visit } from "@/types/field-services";

const LATE_AFTER_MS = 15 * 60_000;
const LOOKAHEAD_MS = 24 * 3_600_000;
const LOOKBACK_MS = 7 * 24 * 3_600_000;
const MAX_ALERTS_PER_RUN = 100;
const PAGE_SIZE = 500;
const MAX_SCAN = 3_000;

export interface MonitorResult {
  checked: number;
  late: number;
  unassigned: number;
  timesheetReminders: number;
}

export async function runFieldMonitor(now: Date = new Date()): Promise<MonitorResult> {
  const db = getAdminDb();
  const result: MonitorResult = { checked: 0, late: 0, unassigned: 0, timesheetReminders: 0 };

  await closeStaleTimers(async (subAccountId) => {
    const sub = await db.doc(`subAccounts/${subAccountId}`).get();
    if (!fieldServicesAvailable(sub.data())) return null;
    const cfg = await getFieldServicesConfig(subAccountId);
    return cfg.timerMaxHours;
  }).catch((err) => console.warn("[field-monitor] stale timers failed", err));

  result.timesheetReminders = await sendTimesheetReminders(now).catch((err) => {
    console.warn("[field-monitor] timesheet reminders failed", err);
    return 0;
  });

  await refreshInvoicedFlags().catch((err) => console.warn("[field-monitor] invoiced flags failed", err));

  const docs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  while (docs.length < MAX_SCAN) {
    let q = db
      .collection("visits")
      .where("status", "==", "pending")
      .where("scheduledStart", ">=", Timestamp.fromMillis(now.getTime() - LOOKBACK_MS))
      .where("scheduledStart", "<=", Timestamp.fromMillis(now.getTime() + LOOKAHEAD_MS))
      .orderBy("scheduledStart", "asc")
      .limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    docs.push(...page.docs);
    if (page.size < PAGE_SIZE) break;
    cursor = page.docs[page.docs.length - 1];
  }

  const gate = new Map<string, boolean>();
  const gateOn = async (subAccountId: string) => {
    if (!gate.has(subAccountId)) {
      const sub = await db.doc(`subAccounts/${subAccountId}`).get();
      gate.set(subAccountId, fieldServicesAvailable(sub.data()));
    }
    return gate.get(subAccountId)!;
  };

  for (const doc of docs) {
    if (result.late + result.unassigned >= MAX_ALERTS_PER_RUN) break;
    const v = { id: doc.id, ...doc.data() } as Visit & {
      lateAlertedAt?: unknown;
      unassignedAlertedAt?: unknown;
    };
    result.checked++;
    if (!(await gateOn(v.subAccountId))) continue;

    const start = (v.scheduledStart as Timestamp | null)?.toDate?.();
    if (!start) continue;
    const label = `${v.jobNumber} ${v.jobTitle}`.trim();
    const url = `/sa/${v.subAccountId}/field-services`;

    if (v.workerIds.length === 0) {
      if (v.unassignedAlertedAt) continue;
      await alert(v, {
        title: `Visit with no worker: ${label}`,
        notes: `${v.contactName} is booked for ${start.toISOString()} and nobody is assigned yet.`,
        push: `🧰 Unassigned visit: ${label}`,
        url,
        flag: "unassignedAlertedAt",
      });
      result.unassigned++;
    } else if (!v.anytime && now.getTime() - start.getTime() >= LATE_AFTER_MS) {
      if (v.lateAlertedAt) continue;
      await alert(v, {
        title: `Visit not started: ${label}`,
        notes: `${v.contactName} was due at ${start.toISOString()} and nobody has marked the visit started.`,
        push: `⏰ Visit not started: ${label}`,
        url,
        flag: "lateAlertedAt",
      });
      result.late++;
    }
  }
  return result;
}

async function alert(
  v: Visit,
  a: { title: string; notes: string; push: string; url: string; flag: string },
): Promise<void> {
  await getAdminDb()
    .doc(`visits/${v.id}`)
    .update({ [a.flag]: FieldValue.serverTimestamp() });
  await createTaskServerSide({
    subAccountId: v.subAccountId,
    agencyId: v.agencyId,
    createdByUid: "field-monitor",
    mode: "live",
    title: a.title,
    notes: a.notes,
    dueAt: null,
    contactId: v.contactId,
    dealId: null,
    eventId: null,
  }).catch((err) => console.warn("[field-monitor] task failed", err));
  await sendPushForEvent({
    subAccountId: v.subAccountId,
    agencyId: v.agencyId,
    title: a.push,
    body: a.notes.slice(0, 140),
    territoryId: v.territoryId,
    url: a.url,
    tag: `field-${a.flag}-${v.id}`,
  }).catch((err) => console.warn("[field-monitor] push failed", err));
}

/** Re-checks finished projects that have an invoice, so deleted invoices and later work show up on the lists. */
async function refreshInvoicedFlags(): Promise<void> {
  const snap = await getAdminDb().collection("jobs").where("status", "==", "ready_to_invoice").limit(300).get();
  const todo = snap.docs.filter((d) => ((d.data().invoiceIds as string[] | undefined)?.length ?? 0) > 0 && d.data().jobType !== "recurring");
  for (let i = 0; i < todo.length; i += 10) {
    await Promise.all(
      todo.slice(i, i + 10).map((d) =>
        refreshInvoicedFlag(d.data().subAccountId as string, d.id).catch(() => {}),
      ),
    );
  }
}
