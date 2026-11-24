import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { mondayOf } from "@/lib/field-services/intervals";
import { utcToZonedInput } from "@/lib/field-services/time";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import {
  readSheet,
  weekTotals,
  workspaceTimezone,
} from "@/lib/server/field-timesheet-service";
import { pushToWorker } from "@/lib/server/field-worker-push";

const LOOKBACK_MS = 8 * 86_400_000;
const MAX_SCAN = 1_500;
const MAX_REMINDERS = 200;
const REMINDER_DAY = 5; // Friday
const REMINDER_HOUR = 15;

/**
 * Friday 3pm local: nudges workers who logged time this week and have not submitted. Each worker is claimed first,
 * so they are told at most once a week.
 */
export async function sendTimesheetReminders(now: Date = new Date()): Promise<number> {
  // Friday 3pm somewhere falls between Thursday and early Saturday UTC, so skip the scan the rest of the week.
  const utcDay = now.getUTCDay();
  if (!(utcDay === 4 || utcDay === 5 || (utcDay === 6 && now.getUTCHours() < 5))) return 0;
  const db = getAdminDb();
  const snap = await db
    .collection("fieldWorkdays")
    .where("lastEntryAt", ">=", Timestamp.fromMillis(now.getTime() - LOOKBACK_MS))
    .limit(MAX_SCAN)
    .get();

  const subs = new Map<string, { on: boolean; tz: string }>();
  const subInfo = async (subAccountId: string) => {
    let info = subs.get(subAccountId);
    if (!info) {
      const sub = (await db.doc(`subAccounts/${subAccountId}`).get()).data();
      const on =
        fieldServicesAvailable(sub) &&
        (await getFieldServicesConfig(subAccountId)).timesheetsEnabled;
      info = { on, tz: on ? await workspaceTimezone(subAccountId) : "UTC" };
      subs.set(subAccountId, info);
    }
    return info;
  };

  let sent = 0;
  for (const doc of snap.docs) {
    if (sent >= MAX_REMINDERS) break;
    try {
      const wd = doc.data();
      const subAccountId = String(wd.subAccountId ?? "");
      const workerId = String(wd.workerId ?? doc.id);
      if (!subAccountId) continue;
      const info = await subInfo(subAccountId);
      if (!info.on) continue;

      const local = utcToZonedInput(now, info.tz);
      const dayKey = local.slice(0, 10);
      if (new Date(`${dayKey}T00:00:00Z`).getUTCDay() !== REMINDER_DAY) continue;
      if (Number(local.slice(11, 13)) !== REMINDER_HOUR) continue;
      const weekStart = mondayOf(dayKey);
      if (wd.timesheetReminderWeek === weekStart) continue;

      const sheet = await readSheet(subAccountId, workerId, weekStart);
      if (sheet.status === "submitted" || sheet.status === "approved") continue;
      const totals = await weekTotals(subAccountId, workerId, weekStart, info.tz);
      if (totals.count === 0) continue;

      // Claim the week before sending, so two overlapping runs cannot both send.
      await doc.ref.update({ timesheetReminderWeek: weekStart });
      await pushToWorker(workerId, {
        title: "Submit your timesheet",
        body: "You have time logged this week. Open Time and tap Submit week.",
        tag: `timesheet-reminder-${weekStart}`,
      });
      sent++;
    } catch (err) {
      // One bad workspace or worker must not stop everyone else's reminder.
      console.warn("[timesheet-reminder] skipped one worker", err);
    }
  }
  return sent;
}
