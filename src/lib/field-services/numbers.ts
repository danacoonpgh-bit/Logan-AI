import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

export type FieldNumberKind = "request" | "job";

const META: Record<FieldNumberKind, { counterDoc: string; prefix: string }> = {
  request: { counterDoc: "requestNumbers", prefix: "R" },
  job: { counterDoc: "jobNumbers", prefix: "J" },
};

export async function issueFieldNumber(
  subAccountId: string,
  kind: FieldNumberKind,
  now: Date = new Date(),
): Promise<string> {
  if (!subAccountId) throw new Error("subAccountId required");
  const meta = META[kind];
  const year = now.getUTCFullYear();
  const db = getAdminDb();
  const ref = db
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("counters")
    .doc(meta.counterDoc);

  const seq = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const next = (data && data.year === year ? (data.seq ?? 0) : 0) + 1;
    tx.set(ref, { year, seq: next, updatedAt: new Date() }, { merge: true });
    return next;
  });

  return `${meta.prefix}-${year}-${String(seq).padStart(4, "0")}`;
}
