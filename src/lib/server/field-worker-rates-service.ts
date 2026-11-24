import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { forcedCurrency } from "@/lib/server/field-currency-service";

/** What a person costs and what they are charged out at, per hour. Kept apart from the staff record, so only admins' routes read it. */
export interface WorkerRates {
  costRateMinor: number;
  sellRateMinor: number;
  currency: string;
}

const NONE: WorkerRates = { costRateMinor: 0, sellRateMinor: 0, currency: "" };
const MAX_MINOR = 100_000_000;

function fromDoc(d: Record<string, unknown> | undefined): WorkerRates {
  if (!d) return NONE;
  return {
    costRateMinor: Number(d.costRateMinor) || 0,
    sellRateMinor: Number(d.sellRateMinor) || 0,
    currency: typeof d.currency === "string" ? d.currency : "",
  };
}

export async function getWorkerRates(subAccountId: string, workerId: string): Promise<WorkerRates> {
  const snap = await getAdminDb().doc(`fieldWorkerRates/${workerId}`).get();
  const d = snap.data();
  return d && d.subAccountId === subAccountId ? fromDoc(d) : NONE;
}

export async function listWorkerRates(subAccountId: string): Promise<Map<string, WorkerRates>> {
  const snap = await getAdminDb().collection("fieldWorkerRates").where("subAccountId", "==", subAccountId).get();
  return new Map(snap.docs.map((d) => [d.id, fromDoc(d.data())]));
}

export async function setWorkerRates(input: {
  subAccountId: string;
  workerId: string;
  body: Record<string, unknown>;
}): Promise<WorkerRates> {
  const db = getAdminDb();
  const worker = (await db.doc(`fieldWorkers/${input.workerId}`).get()).data();
  if (!worker || worker.subAccountId !== input.subAccountId) throw new FieldServicesError("Worker not found.", 404);
  const money = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_MINOR) {
      throw new FieldServicesError(`Enter the ${what} as an amount of money.`);
    }
    return v;
  };
  const cost = money(input.body.costRateMinor, "cost rate");
  const sell = money(input.body.sellRateMinor, "sell rate");
  if (cost <= 0) throw new FieldServicesError("Set a cost rate. It is what each hour of this person's time costs you.");
  if (sell <= 0) throw new FieldServicesError("Set a sell rate. It is what you charge for each hour this person works.");
  const asked = typeof input.body.currency === "string" ? input.body.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(asked)) throw new FieldServicesError("Enter the currency, for example USD.");
  const currency = await forcedCurrency(input.subAccountId, asked);
  const rates = { costRateMinor: cost, sellRateMinor: sell, currency };
  await db.doc(`fieldWorkerRates/${input.workerId}`).set({
    subAccountId: input.subAccountId,
    ...rates,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await repriceEstimates(input.subAccountId, input.workerId, sell, currency);
  return rates;
}

/** Estimate lines on open projects follow a person's current sell rate, except lines whose price was typed over. */
async function repriceEstimates(subAccountId: string, workerId: string, sellMinor: number, currency: string): Promise<void> {
  const db = getAdminDb();
  const jobs = await db.collection("jobs").where("subAccountId", "==", subAccountId).get();
  let batch = db.batch();
  let n = 0;
  for (const d of jobs.docs) {
    const j = d.data();
    if (j.status === "closed" || j.status === "cancelled" || j.currency !== currency) continue;
    const lines = (j.estimateLines ?? []) as { workerId?: string; priceLocked?: boolean; unitPriceMinor: number }[];
    if (!lines.some((l) => l.workerId === workerId && !l.priceLocked && l.unitPriceMinor !== sellMinor)) continue;
    batch.update(d.ref, {
      estimateLines: lines.map((l) => (l.workerId === workerId && !l.priceLocked ? { ...l, unitPriceMinor: sellMinor } : l)),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (++n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
}
