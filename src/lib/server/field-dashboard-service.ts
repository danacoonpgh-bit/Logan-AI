import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { unitToMinor } from "@/lib/field-services/money";
import { zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { workspaceTimezone } from "@/lib/server/field-timesheet-service";
import type { Quote } from "@/types/quotes";

export interface DashboardMoney {
  currency: string;
  billedMinor: number;
  paidMinor: number;
}

export interface DashboardServerStats {
  /** Weeks sent in by staff and waiting for approval. Null while timesheets are off. */
  timesheetsToApprove: number | null;
  /** This month's invoices on field projects, largest currency first. Null when it could not be worked out. */
  money: DashboardMoney[] | null;
}

/** The figures on the Home tab that need a server read: weeks to approve, and what has been billed this month. Admin only. */
export async function fieldDashboardStats(subAccountId: string): Promise<DashboardServerStats> {
  const db = getAdminDb();
  const config = await getFieldServicesConfig(subAccountId);

  let timesheetsToApprove: number | null = null;
  if (config.timesheetsEnabled) {
    try {
      const snap = await db
        .collection("fieldTimesheets")
        .where("subAccountId", "==", subAccountId)
        .where("status", "==", "submitted")
        .count()
        .get();
      timesheetsToApprove = snap.data().count;
    } catch (err) {
      console.warn("[field-dashboard] timesheet count failed", err);
    }
  }

  let money: DashboardMoney[] | null = null;
  try {
    const tz = await workspaceTimezone(subAccountId);
    const monthStart = zonedTimeToUtc(`${zonedDateKey(new Date(), tz).slice(0, 7)}-01T00:00`, tz);
    const snap = await db
      .collection("quotes")
      .where("subAccountId", "==", subAccountId)
      .where("kind", "==", "invoice")
      .where("createdAt", ">=", Timestamp.fromDate(monthStart))
      .limit(1_000)
      .get();
    const by = new Map<string, DashboardMoney>();
    for (const d of snap.docs) {
      const q = d.data() as Quote;
      if (!q.jobId || !["sent", "viewed", "accepted", "paid"].includes(q.status)) continue;
      const minor = unitToMinor(q.currency, computeQuoteTotals(q).total);
      const row = by.get(q.currency) ?? { currency: q.currency, billedMinor: 0, paidMinor: 0 };
      row.billedMinor += minor;
      if (q.status === "paid") row.paidMinor += minor;
      by.set(q.currency, row);
    }
    money = [...by.values()].sort((a, b) => b.billedMinor - a.billedMinor);
  } catch (err) {
    // The index for this query may still be building.
    console.warn("[field-dashboard] invoice totals failed", err);
  }
  return { timesheetsToApprove, money };
}
