import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { EXPENSE_CATEGORIES } from "@/lib/field-services/expense-categories";
import { isDayKey, mondayOf } from "@/lib/field-services/intervals";
import { addDaysToKey, zonedDateKey, zonedTimeToUtc } from "@/lib/field-services/time";
import type { FieldActor } from "@/lib/server/field-access";
import { getFieldServicesConfig } from "@/lib/server/field-services-config-service";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { workspaceCurrency } from "@/lib/server/field-currency-service";
import { listTimeTargets } from "@/lib/server/field-time-targets-service";
import { assertWeekEditable, workspaceTimezone } from "@/lib/server/field-timesheet-service";

const MAX_AMOUNT_MINOR = 10_000_000;
const MAX_PER_WEEK = 100;
const MAX_DAYS_BACK = 62;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,40}$/;
const ID = /^[A-Za-z0-9_-]{6,80}$/;

export interface CrewExpenseView {
  id: string;
  date: string;
  category: string;
  description: string;
  amountMinor: number;
  currency: string;
  /** The job or internal job the claim is for, in words. Empty when it is not for one. */
  label: string;
  target: { type: "job" | "internal" | "none"; id: string | null };
  /** The worker can't change it because the week is submitted or approved. */
  locked: boolean;
}

/** Currency for a claim that is not tied to a job: the worker's rate card, else the job of one of their visits, else USD. */
export async function defaultExpenseCurrency(subAccountId: string, workerId: string): Promise<string> {
  const chosen = await workspaceCurrency(subAccountId);
  if (chosen) return chosen;
  const db = getAdminDb();
  const worker = (await db.doc(`fieldWorkers/${workerId}`).get()).data();
  const cardId = worker?.subAccountId === subAccountId ? worker?.rateCardId : null;
  if (typeof cardId === "string" && ID.test(cardId)) {
    const card = (await db.doc(`fieldRateCards/${cardId}`).get()).data();
    if (card?.subAccountId === subAccountId && typeof card.currency === "string") return card.currency;
  }
  const visit = await db
    .collection("visits")
    .where("subAccountId", "==", subAccountId)
    .where("workerIds", "array-contains", workerId)
    .limit(1)
    .get();
  const jobId = visit.docs[0]?.data().jobId;
  if (typeof jobId === "string" && ID.test(jobId)) {
    const job = (await db.doc(`jobs/${jobId}`).get()).data();
    if (job?.subAccountId === subAccountId && typeof job.currency === "string") return job.currency;
  }
  return "USD";
}

export async function listWeekExpenses(input: {
  subAccountId: string;
  workerId: string;
  weekStart: string;
}): Promise<CrewExpenseView[]> {
  const { subAccountId, workerId, weekStart } = input;
  const db = getAdminDb();
  const snap = await db
    .collection("fieldExpenses")
    .where("workerId", "==", workerId)
    .where("weekStart", "==", weekStart)
    .get();
  const rows = snap.docs.filter((d) => d.data().subAccountId === subAccountId && d.data().voided !== true);

  const jobIds = new Set<string>();
  const internalIds = new Set<string>();
  for (const d of rows) {
    const e = d.data();
    if (typeof e.jobId === "string") jobIds.add(e.jobId);
    if (typeof e.internalJobId === "string") internalIds.add(e.internalJobId);
  }
  const [jobDocs, internalDocs] = await Promise.all([
    jobIds.size ? db.getAll(...[...jobIds].map((id) => db.doc(`jobs/${id}`))) : Promise.resolve([]),
    internalIds.size ? db.getAll(...[...internalIds].map((id) => db.doc(`fieldInternalJobs/${id}`))) : Promise.resolve([]),
  ]);
  const labels = new Map<string, string>();
  for (const j of jobDocs) {
    if (j.exists && j.data()?.subAccountId === subAccountId) {
      labels.set(j.id, `${j.data()?.number ?? ""} ${j.data()?.title ?? ""}`.trim());
    }
  }
  for (const j of internalDocs) {
    if (j.exists && j.data()?.subAccountId === subAccountId) labels.set(j.id, String(j.data()?.name ?? ""));
  }

  return rows
    .map((d): CrewExpenseView => {
      const e = d.data();
      const jobId = typeof e.jobId === "string" ? e.jobId : null;
      const internalJobId = typeof e.internalJobId === "string" ? e.internalJobId : null;
      return {
        id: d.id,
        date: String(e.date ?? ""),
        category: String(e.category ?? "other"),
        description: String(e.description ?? ""),
        amountMinor: Number(e.amountMinor) || 0,
        currency: String(e.currency ?? "USD"),
        label: (jobId ? labels.get(jobId) : internalJobId ? labels.get(internalJobId) : "") ?? "",
        target: jobId
          ? { type: "job", id: jobId }
          : internalJobId
            ? { type: "internal", id: internalJobId }
            : { type: "none", id: null },
        locked: false,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

interface Cleaned {
  date: string;
  category: string;
  description: string;
  amountMinor: number;
}

async function cleanFields(body: Record<string, unknown>, tz: string, unchangedDate?: string): Promise<Cleaned> {
  if (!isDayKey(body.date)) throw new FieldServicesError("Choose the date of the expense.");
  const today = zonedDateKey(new Date(), tz);
  // A claim keeps its old date when only the text or amount changes.
  if (body.date !== unchangedDate) {
    if (body.date > today) throw new FieldServicesError("The date can't be in the future.");
    if (body.date < addDaysToKey(today, -MAX_DAYS_BACK)) {
      throw new FieldServicesError("That is too long ago. Ask the office to add it.");
    }
  }
  const category = typeof body.category === "string" ? body.category : "";
  if (!Object.hasOwn(EXPENSE_CATEGORIES, category)) throw new FieldServicesError("Choose a category.");
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 200) : "";
  if (!description) throw new FieldServicesError("Say what the expense was for.");
  const amountMinor = body.amountMinor;
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_AMOUNT_MINOR) {
    throw new FieldServicesError("Enter the amount you paid.");
  }
  return { date: body.date, category, description, amountMinor };
}

function dayInstant(date: string, tz: string): Date {
  return zonedTimeToUtc(`${date}T12:00`, tz);
}

/** Where a claim may be charged: a job or internal job the worker can book time to, or nothing. */
async function resolveTarget(
  subAccountId: string,
  workerId: string,
  body: Record<string, unknown>,
): Promise<{ jobId: string | null; internalJobId: string | null; currency: string }> {
  const t = body.target;
  const type = t && typeof t === "object" ? (t as Record<string, unknown>).type : "none";
  const id = t && typeof t === "object" ? (t as Record<string, unknown>).id : null;
  if (type === "none" || type === undefined) {
    return { jobId: null, internalJobId: null, currency: await defaultExpenseCurrency(subAccountId, workerId) };
  }
  if ((type !== "job" && type !== "internal") || typeof id !== "string" || !ID.test(id)) {
    throw new FieldServicesError("Choose where this expense goes.");
  }
  const targets = await listTimeTargets({ subAccountId, workerId });
  if (type === "internal") {
    if (!targets.internalJobs.some((j) => j.id === id)) throw new FieldServicesError("You can't claim against that.", 403);
    return { jobId: null, internalJobId: id, currency: await defaultExpenseCurrency(subAccountId, workerId) };
  }
  if (!targets.jobs.some((j) => j.id === id)) throw new FieldServicesError("You can't claim against that.", 403);
  const job = (await getAdminDb().doc(`jobs/${id}`).get()).data();
  if (!job || job.subAccountId !== subAccountId) throw new FieldServicesError("Not found.", 404);
  return { jobId: id, internalJobId: null, currency: typeof job.currency === "string" ? job.currency : "USD" };
}

async function ownWorker(subAccountId: string, actor: FieldActor): Promise<string> {
  if (actor.isOffice || !actor.workerId) {
    throw new FieldServicesError("Only a worker with a profile can claim expenses.", 403);
  }
  if (!(await getFieldServicesConfig(subAccountId)).timesheetsEnabled) {
    throw new FieldServicesError("Timesheets are switched off for this workspace.", 409);
  }
  return actor.workerId;
}

export async function addExpense(input: {
  subAccountId: string;
  actor: FieldActor;
  body: Record<string, unknown>;
}): Promise<{ id: string }> {
  const { subAccountId, body } = input;
  const workerId = await ownWorker(subAccountId, input.actor);
  const db = getAdminDb();
  // A retry of a claim that already saved must report success even if the week has locked since.
  const clientId = typeof body.clientId === "string" && CLIENT_ID.test(body.clientId) ? body.clientId : null;
  const ref = clientId ? db.doc(`fieldExpenses/ce_${workerId}_${clientId}`) : db.collection("fieldExpenses").doc();
  if (clientId) {
    const prior = await ref.get();
    if (prior.exists) {
      if (prior.data()?.voided === true) throw new FieldServicesError("That expense was removed.", 409);
      return { id: ref.id };
    }
  }

  const tz = await workspaceTimezone(subAccountId);
  const fields = await cleanFields(body, tz);
  await assertWeekEditable(subAccountId, workerId, dayInstant(fields.date, tz));
  const target = await resolveTarget(subAccountId, workerId, body);
  const worker = (await db.doc(`fieldWorkers/${workerId}`).get()).data();
  if (!worker || worker.subAccountId !== subAccountId) throw new FieldServicesError("Worker not found.", 404);

  const weekStart = mondayOf(fields.date);

  const existing = await db
    .collection("fieldExpenses")
    .where("workerId", "==", workerId)
    .where("weekStart", "==", weekStart)
    .where("voided", "==", false)
    .count()
    .get();
  if (existing.data().count >= MAX_PER_WEEK) {
    throw new FieldServicesError("That is the most claims for one week. Ask the office.", 409);
  }

  try {
    await ref.create({
      agencyId: worker.agencyId,
      subAccountId,
      workerId,
      ...target,
      ...fields,
      weekStart,
      voided: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // The same claim sent twice at once: the other request won.
    if ((err as { code?: number }).code === 6) return { id: ref.id };
    throw err;
  }
  return { id: ref.id };
}

async function ownExpense(subAccountId: string, workerId: string, expenseId: unknown) {
  if (typeof expenseId !== "string" || !/^[A-Za-z0-9_-]{6,120}$/.test(expenseId)) {
    throw new FieldServicesError("Expense not found.", 404);
  }
  const ref = getAdminDb().doc(`fieldExpenses/${expenseId}`);
  const data = (await ref.get()).data();
  if (!data || data.subAccountId !== subAccountId || data.voided === true) {
    throw new FieldServicesError("Expense not found.", 404);
  }
  if (data.workerId !== workerId) throw new FieldServicesError("That isn't your expense.", 403);
  return { ref, data };
}

export async function editExpense(input: {
  subAccountId: string;
  actor: FieldActor;
  expenseId: unknown;
  body: Record<string, unknown>;
}): Promise<void> {
  const { subAccountId, body } = input;
  const workerId = await ownWorker(subAccountId, input.actor);
  const tz = await workspaceTimezone(subAccountId);
  const { ref, data } = await ownExpense(subAccountId, workerId, input.expenseId);
  await assertWeekEditable(subAccountId, workerId, dayInstant(String(data.date), tz));
  const fields = await cleanFields(body, tz, String(data.date));
  await assertWeekEditable(subAccountId, workerId, dayInstant(fields.date, tz));
  const target = body.target === undefined ? null : await resolveTarget(subAccountId, workerId, body);
  await ref.update({
    ...fields,
    ...(target ?? {}),
    weekStart: mondayOf(fields.date),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function voidExpense(input: {
  subAccountId: string;
  actor: FieldActor;
  expenseId: unknown;
}): Promise<void> {
  const { subAccountId } = input;
  const workerId = await ownWorker(subAccountId, input.actor);
  const tz = await workspaceTimezone(subAccountId);
  const { ref, data } = await ownExpense(subAccountId, workerId, input.expenseId);
  await assertWeekEditable(subAccountId, workerId, dayInstant(String(data.date), tz));
  await ref.update({ voided: true, updatedAt: FieldValue.serverTimestamp() });
}
