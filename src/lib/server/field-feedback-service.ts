import { fieldServicesAvailable } from "@/lib/field-services/availability";
import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { hitLimit } from "@/lib/server/field-rate-limit";
import { FieldServicesError } from "@/lib/server/field-services-errors";

export async function feedbackAnswered(subAccountId: string): Promise<boolean> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}/fieldServicesConfig/main`).get();
  return !!snap.data()?.feedbackAnsweredAt;
}

export async function submitFieldFeedback(input: {
  agencyId: string;
  subAccountId: string;
  uid: string;
  role: string;
  helpful: unknown;
  text: unknown;
  source: unknown;
}): Promise<void> {
  const text = typeof input.text === "string" ? input.text.trim().slice(0, 2_000) : "";
  const helpful = typeof input.helpful === "boolean" ? input.helpful : null;
  if (helpful === null && !text) throw new FieldServicesError("Add a note or choose Yes or No.");
  const limit = await hitLimit(`fieldfb:${input.subAccountId}`, 10, 24 * 3_600_000);
  if (!limit.ok) throw new FieldServicesError("Thanks, we have plenty from you today.", 429);

  const db = getAdminDb();
  const source = input.source === "first_job" ? "first_job" : "link";
  await db.collection("fieldFeedback").add({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    uid: input.uid,
    role: input.role,
    helpful,
    text,
    source,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (source === "first_job") {
    await db
      .doc(`subAccounts/${input.subAccountId}/fieldServicesConfig/main`)
      .set({ feedbackAnsweredAt: FieldValue.serverTimestamp() }, { merge: true });
  }
}

export interface FeedbackRow {
  id: string;
  subAccountName: string;
  helpful: boolean | null;
  text: string;
  source: string;
  at: number;
}

export interface UsageRow {
  subAccountId: string;
  name: string;
  requests: number;
  jobs: number;
  jobsDone: number;
  visitsDone: number;
  timeEntries: number;
  payments: number;
}

async function count(q: FirebaseFirestore.Query): Promise<number> {
  return (await q.count().get()).data().count;
}

export async function agencyFieldFeedback(agencyId: string): Promise<FeedbackRow[]> {
  const db = getAdminDb();
  const [fb, subs] = await Promise.all([
    db.collection("fieldFeedback").where("agencyId", "==", agencyId).orderBy("createdAt", "desc").limit(200).get(),
    db.collection("subAccounts").where("agencyId", "==", agencyId).get(),
  ]);
  const names = new Map(subs.docs.map((d) => [d.id, (d.data().name as string) ?? d.id]));
  return fb.docs
    .map((d) => {
      const f = d.data();
      return {
        id: d.id,
        subAccountName: names.get(f.subAccountId as string) ?? "",
        helpful: (f.helpful as boolean | null) ?? null,
        text: (f.text as string) ?? "",
        source: (f.source as string) ?? "link",
        at: (f.createdAt as Timestamp | undefined)?.toMillis?.() ?? 0,
      };
    })
    .sort((a, b) => b.at - a.at);
}

/** Counts from existing records, for the agency's view of who is really using it. */
export async function agencyFieldUsage(agencyId: string): Promise<UsageRow[]> {
  const db = getAdminDb();
  const subs = await db.collection("subAccounts").where("agencyId", "==", agencyId).get();
  const enabled = subs.docs.filter((d) => fieldServicesAvailable(d.data()));
  return Promise.all(
    enabled.map(async (d) => {
      const sa = d.id;
      const base = (c: string) => db.collection(c).where("subAccountId", "==", sa);
      const [requests, jobs, jobsDone, visitsDone, timeEntries, payments] = await Promise.all([
        count(base("serviceRequests")),
        count(base("jobs")),
        count(base("jobs").where("status", "in", ["ready_to_invoice", "closed"])),
        count(base("visits").where("status", "==", "completed")),
        count(base("timeEntries")),
        count(base("jobPayments")),
      ]);
      return {
        subAccountId: sa,
        name: (d.data().name as string) ?? sa,
        requests,
        jobs,
        jobsDone,
        visitsDone,
        timeEntries,
        payments,
      };
    }),
  );
}
