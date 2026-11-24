import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { FieldServicesError } from "@/lib/server/field-services-errors";

/**
 * One currency for a workspace's Field Services money. New records always use it; older ones are relabelled when it is
 * first chosen (same numbers, no conversion), as long as nothing has been invoiced, paid or claimed.
 */

const CODE = /^[A-Z]{3}$/;
const BATCH = 400;
const SCAN = 500;

function configRef(subAccountId: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}/fieldServicesConfig/main`);
}

/** The chosen currency, or null while the workspace has not chosen one. */
export async function workspaceCurrency(subAccountId: string): Promise<string | null> {
  const v = (await configRef(subAccountId).get()).data()?.currency;
  return typeof v === "string" && CODE.test(v) ? v : null;
}

/**
 * The workspace currency when chosen. Until then the currency the workspace already uses (its first project), so an
 * unconfigured workspace never starts mixing; otherwise what was asked for, otherwise USD.
 */
export async function forcedCurrency(subAccountId: string, requested?: unknown): Promise<string> {
  const chosen = await workspaceCurrency(subAccountId);
  if (chosen) return chosen;
  const existing = await getAdminDb().collection("jobs").where("subAccountId", "==", subAccountId).limit(1).get();
  const used = existing.docs[0]?.data().currency;
  if (typeof used === "string" && CODE.test(used)) return used;
  if (typeof requested === "string" && CODE.test(requested.trim().toUpperCase())) return requested.trim().toUpperCase();
  return "USD";
}

function validCode(raw: unknown): string {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!CODE.test(code)) throw new FieldServicesError("Use a three-letter currency code, like USD or AUD.");
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
  } catch {
    throw new FieldServicesError(`${code} is not a currency code.`);
  }
  return code;
}

/** Currencies on records that cannot simply be relabelled (invoices, estimates, expenses, payments), or null when there are none. */
async function moneyAlreadyRecorded(subAccountId: string): Promise<Set<string> | null> {
  const db = getAdminDb();
  const used = new Set<string>();
  let any = false;

  const jobs = await db.collection("jobs").where("subAccountId", "==", subAccountId).get();
  for (const d of jobs.docs) {
    const j = d.data();
    const invoiced =
      (Array.isArray(j.invoiceIds) && j.invoiceIds.length > 0) ||
      Boolean(j.quoteId) ||
      Boolean(j.depositInvoiceId) ||
      Boolean(j.travelFeeInvoiceId);
    if (invoiced) {
      any = true;
      if (typeof j.currency === "string") used.add(j.currency);
    }
  }
  for (const name of ["fieldExpenses", "jobPayments"] as const) {
    const snap = await db.collection(name).where("subAccountId", "==", subAccountId).limit(SCAN).get();
    for (const d of snap.docs) {
      any = true;
      const c = d.data().currency;
      used.add(typeof c === "string" && c ? c : "USD");
    }
  }
  return any ? used : null;
}

async function relabel(
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  update: (d: FirebaseFirestore.QueryDocumentSnapshot) => Record<string, unknown>,
): Promise<void> {
  const db = getAdminDb();
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + BATCH)) batch.update(d.ref, update(d));
    await batch.commit();
  }
}

/** Chooses the workspace currency. Returns the code to store on the config. */
export async function applyWorkspaceCurrency(subAccountId: string, raw: unknown): Promise<string> {
  const target = validCode(raw);
  const current = await workspaceCurrency(subAccountId);
  if (current === target) return target;

  const recorded = await moneyAlreadyRecorded(subAccountId);
  if (recorded) {
    const others = [...recorded].filter((c) => c !== target);
    if (others.length > 0) {
      throw new FieldServicesError(
        `Invoices, expenses or payments already exist in ${others.join(", ")}, so the currency cannot be changed to ${target}.`,
        409,
      );
    }
    // Everything already recorded uses the target; the rest is relabelled below.
  }

  const db = getAdminDb();
  const stamp = { currency: target, updatedAt: FieldValue.serverTimestamp() };
  const [jobs, cards, rates, services, approvals] = await Promise.all([
    db.collection("jobs").where("subAccountId", "==", subAccountId).get(),
    db.collection("fieldRateCards").where("subAccountId", "==", subAccountId).get(),
    db.collection("fieldWorkerRates").where("subAccountId", "==", subAccountId).get(),
    db.collection("products").where("subAccountId", "==", subAccountId).where("kind", "==", "service").get(),
    db.collection("jobApprovals").where("subAccountId", "==", subAccountId).get(),
  ]);
  await relabel(jobs.docs, () => stamp);
  await relabel(cards.docs, () => stamp);
  await relabel(rates.docs, () => stamp);
  await relabel(services.docs, () => stamp);
  await relabel(approvals.docs, () => stamp);
  return target;
}
