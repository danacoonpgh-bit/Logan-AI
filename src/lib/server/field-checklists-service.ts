import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { getJobTerms } from "@/lib/server/field-services-config-service";
import type {
  ChecklistItem,
  ChecklistTemplate,
  Job,
  JobLineItem,
  Visit,
} from "@/types/field-services";

const MAX_TEMPLATE_ITEMS = 30;
const MAX_VISIT_ITEMS = 60;
const ID = /^[A-Za-z0-9_-]{6,80}$/;
const FINAL = ["completed", "no_show", "cancelled"];

function plain(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "";
}

function templateRef(subAccountId: string, productId: string) {
  return getAdminDb().doc(`fieldChecklistTemplates/${subAccountId}_${productId}`);
}

export interface ChecklistTemplateView {
  productId: string;
  productName: string;
  items: { id: string; text: string; required: boolean }[];
  requireChecklist: boolean;
  requireSignature: boolean;
}

function viewOf(t: Partial<ChecklistTemplate>): ChecklistTemplateView {
  return {
    productId: t.productId ?? "",
    productName: t.productName ?? "",
    items: (t.items ?? []).map((i) => ({ id: i.id, text: i.text, required: i.required === true })),
    requireChecklist: t.requireChecklist === true,
    requireSignature: t.requireSignature === true,
  };
}

export async function listChecklistTemplates(subAccountId: string): Promise<ChecklistTemplateView[]> {
  const snap = await getAdminDb()
    .collection("fieldChecklistTemplates")
    .where("subAccountId", "==", subAccountId)
    .get();
  return snap.docs.map((d) => viewOf(d.data() as Partial<ChecklistTemplate>));
}

/** Saves the checklist for one service. A service with no items and nothing required has no checklist. */
export async function saveChecklistTemplate(input: {
  agencyId: string;
  subAccountId: string;
  productId: unknown;
  items: unknown;
  requireChecklist: unknown;
  requireSignature: unknown;
}): Promise<ChecklistTemplateView | null> {
  const productId = typeof input.productId === "string" ? input.productId : "";
  if (!ID.test(productId)) throw new FieldServicesError("Choose a service.");
  const db = getAdminDb();
  const product = (await db.doc(`products/${productId}`).get()).data();
  if (!product || product.subAccountId !== input.subAccountId || product.kind !== "service") {
    throw new FieldServicesError("Service not found.", 404);
  }
  if (input.items !== undefined && !Array.isArray(input.items)) {
    throw new FieldServicesError("Items must be a list.");
  }
  const raw = (input.items as unknown[] | undefined) ?? [];
  if (raw.length > MAX_TEMPLATE_ITEMS) {
    throw new FieldServicesError(`A checklist can have up to ${MAX_TEMPLATE_ITEMS} items.`);
  }
  const seen = new Set<string>();
  const items = raw
    .map((r) => {
      const i = r as { id?: unknown; text?: unknown; required?: unknown };
      const text = plain(i.text, 120);
      if (!text) return null;
      const id = typeof i.id === "string" && ID.test(i.id) && !seen.has(i.id) ? i.id : crypto.randomUUID();
      seen.add(id);
      return { id, text, required: i.required === true };
    })
    .filter((i): i is { id: string; text: string; required: boolean } => i !== null);
  const requireChecklist = input.requireChecklist === true && items.some((i) => i.required);
  const requireSignature = input.requireSignature === true;

  const ref = templateRef(input.subAccountId, productId);
  if (items.length === 0 && !requireSignature) {
    await ref.delete();
    return null;
  }
  const existing = await ref.get();
  await ref.set({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    productId,
    productName: String(product.name ?? "").slice(0, 200),
    items,
    requireChecklist,
    requireSignature,
    createdAt: existing.exists ? existing.data()?.createdAt : FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return viewOf({ productId, productName: String(product.name ?? ""), items, requireChecklist, requireSignature });
}

export interface ChecklistSeed {
  checklist: ChecklistItem[];
  requireChecklist: boolean;
  requireSignature: boolean;
}

/** What a visit for these job lines starts with: the checklist of every service on the job. Null when none has one. */
export async function seedVisitChecklist(
  subAccountId: string,
  lines: JobLineItem[] | undefined,
): Promise<ChecklistSeed | null> {
  try {
    const productIds = [...new Set((lines ?? []).map((l) => l.productId).filter((p): p is string => !!p && ID.test(p)))].slice(0, 20);
    if (productIds.length === 0) return null;
    const snaps = await Promise.all(productIds.map((p) => templateRef(subAccountId, p).get()));
    const checklist: ChecklistItem[] = [];
    let requireChecklist = false;
    let requireSignature = false;
    for (const snap of snaps) {
      const t = snap.data() as ChecklistTemplate | undefined;
      if (!t || t.subAccountId !== subAccountId) continue;
      for (const item of t.items ?? []) {
        if (checklist.length >= MAX_VISIT_ITEMS) break;
        checklist.push({
          id: crypto.randomUUID(),
          text: item.text,
          required: item.required === true,
          done: false,
          source: "service",
          origin: `${t.productId}:${item.id}`,
        });
      }
      if (t.requireChecklist && (t.items ?? []).some((i) => i.required)) requireChecklist = true;
      if (t.requireSignature) requireSignature = true;
    }
    if (checklist.length === 0 && !requireSignature) return null;
    return { checklist, requireChecklist, requireSignature };
  } catch (err) {
    console.warn("[field-checklists] couldn't build the checklist", err);
    return null;
  }
}

/** Office: adds the service checklists the visit doesn't have yet, for example after a service was added to the job. */
export async function refreshVisitChecklist(input: {
  subAccountId: string;
  visitId: string;
}): Promise<{ added: number }> {
  const db = getAdminDb();
  const ref = db.doc(`visits/${input.visitId}`);
  const pre = (await ref.get()).data() as Visit | undefined;
  if (!pre || pre.subAccountId !== input.subAccountId) throw new FieldServicesError("Visit not found.", 404);
  const job = (await db.doc(`jobs/${pre.jobId}`).get()).data() as Job | undefined;
  const seed = job && job.subAccountId === input.subAccountId ? await seedVisitChecklist(input.subAccountId, job.lineItems) : null;
  let added = 0;
  await db.runTransaction(async (tx) => {
    added = 0;
    const snap = await tx.get(ref);
    const v = snap.data() as Visit | undefined;
    if (!v) throw new FieldServicesError("Visit not found.", 404);
    if (FINAL.includes(v.status)) throw new FieldServicesError("This visit is finished.", 409);
    if (v.signoff?.status === "signed") {
      throw new FieldServicesError("The customer already signed off this visit.", 409);
    }
    if (!seed) return;
    const have = v.checklist ?? [];
    const known = new Set(have.map((i) => i.origin).filter(Boolean));
    const fresh = seed.checklist.filter((i) => i.origin && !known.has(i.origin));
    const next = [...have, ...fresh].slice(0, MAX_VISIT_ITEMS);
    added = next.length - have.length;
    tx.update(ref, {
      checklist: next,
      requireChecklist: v.requireChecklist === true || seed.requireChecklist,
      requireSignature: v.requireSignature === true || seed.requireSignature,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { added };
}

/** A worker or the office ticks, adds or removes an item on a visit. */
export async function updateVisitChecklist(input: {
  subAccountId: string;
  visitId: string;
  actor: { isOffice: boolean; workerId: string | null };
  body: Record<string, unknown>;
}): Promise<{ checklist: ChecklistItem[] }> {
  const db = getAdminDb();
  const ref = db.doc(`visits/${input.visitId}`);
  const action = input.body.action;
  if (action !== "tick" && action !== "add" && action !== "remove") {
    throw new FieldServicesError("Unknown checklist action.");
  }
  const itemId = typeof input.body.itemId === "string" ? input.body.itemId : "";
  const text = plain(input.body.text, 120);
  if (action === "add" && !text) throw new FieldServicesError("Type what needs doing.");
  if (action !== "add" && !ID.test(itemId)) throw new FieldServicesError("Item not found.", 404);

  let result: ChecklistItem[] = [];
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const v = snap.data() as Visit | undefined;
    if (!v || v.subAccountId !== input.subAccountId) throw new FieldServicesError("Visit not found.", 404);
    if (!input.actor.isOffice) {
      if (!input.actor.workerId || !v.workerIds.includes(input.actor.workerId)) {
        throw new FieldServicesError("You can only update visits you are assigned to.", 403);
      }
      if (FINAL.includes(v.status)) throw new FieldServicesError("This visit is finished.", 409);
    }
    if (v.status === "cancelled") throw new FieldServicesError("This visit was cancelled.", 409);
    if (v.signoff?.status === "signed") {
      throw new FieldServicesError("The customer already signed off, so the checklist is locked.", 409);
    }
    const job = (await tx.get(db.doc(`jobs/${v.jobId}`))).data();
    if (job && (job.status === "closed" || job.status === "cancelled")) {
      throw new FieldServicesError(`This ${(await getJobTerms(input.subAccountId)).job} is closed.`, 409);
    }
    const list = [...(v.checklist ?? [])];
    if (action === "add") {
      if (list.length >= MAX_VISIT_ITEMS) throw new FieldServicesError("That's a lot of items for one visit.", 409);
      list.push({ id: crypto.randomUUID(), text, required: false, done: false, source: "added" });
    } else {
      const i = list.findIndex((x) => x.id === itemId);
      if (i < 0) throw new FieldServicesError("Item not found.", 404);
      if (action === "remove") {
        if (list[i].source !== "added") {
          throw new FieldServicesError("Items from the service's checklist can't be removed.", 409);
        }
        list.splice(i, 1);
      } else {
        const done = input.body.done === true;
        list[i] = {
          ...list[i],
          done,
          doneAt: done ? Date.now() : null,
          doneByWorkerId: done ? input.actor.workerId : null,
        };
      }
    }
    const reopened = action === "tick" && input.body.done !== true && v.signoff?.status === "pending";
    tx.update(ref, {
      checklist: list,
      ...(reopened ? { signoff: null } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (reopened && v.signoff) {
      tx.update(db.doc(`visitSignoffs/${v.signoff.id}`), {
        status: "cancelled",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    result = list;
  });
  return { checklist: result };
}

export function requiredLeft(v: Pick<Visit, "checklist">): number {
  return (v.checklist ?? []).filter((i) => i.required && !i.done).length;
}
