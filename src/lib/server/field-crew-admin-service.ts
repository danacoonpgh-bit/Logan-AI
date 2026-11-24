import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { pushIsConfigured } from "@/lib/push/config";
import { sendPushToFieldPerson } from "@/lib/push/send-field-person";
import { FieldServicesError } from "@/lib/server/field-services-errors";
import { hitLimit } from "@/lib/server/field-rate-limit";
import { projectVisit } from "@/lib/server/field-portal-access";
import { todayForWorker, type TodayVisit } from "@/lib/server/field-today-service";
import type { PortalLink } from "@/lib/server/field-portal-session-service";

async function loadCrewWorker(subAccountId: string, workerId: string) {
  const snap = await getAdminDb().doc(`fieldWorkers/${workerId}`).get();
  const w = snap.data();
  if (!w || w.subAccountId !== subAccountId) throw new FieldServicesError("Worker not found.", 404);
  return { id: snap.id, data: w };
}

/** Sends a test alert to a crew-app person's phones. Returns how many devices took it. */
export async function sendTestAlert(input: { subAccountId: string; workerId: string }): Promise<number> {
  const { data } = await loadCrewWorker(input.subAccountId, input.workerId);
  if (!data.personId || data.portalStatus !== "active") {
    throw new FieldServicesError("This person hasn't joined the crew app yet.", 409);
  }
  if (!pushIsConfigured()) {
    throw new FieldServicesError("Phone alerts aren't set up on this deployment yet (the push keys are missing).", 409);
  }
  const cap = await hitLimit(`testpush:${input.workerId}`, 5, 3_600_000);
  if (!cap.ok) throw new FieldServicesError("That's plenty of test alerts for now. Try again later.", 429);
  return sendPushToFieldPerson({
    personId: data.personId as string,
    title: "Test alert",
    body: "If you can read this, visit alerts work on this phone.",
    url: `/field/${input.subAccountId}`,
    tag: "test-alert",
  });
}

/** What this worker's day looks like in the crew app, with their price and contact switches applied. */
export async function previewCrewDay(input: {
  subAccountId: string;
  workerId: string;
}): Promise<{ visits: TodayVisit[]; prices: boolean; contact: boolean }> {
  const { id, data } = await loadCrewWorker(input.subAccountId, input.workerId);
  const sub = (await getAdminDb().doc(`subAccounts/${input.subAccountId}`).get()).data();
  const link: PortalLink = {
    workerId: id,
    subAccountId: input.subAccountId,
    agencyId: data.agencyId as string,
    businessName: (sub?.name as string) ?? "",
    name: (data.name as string) ?? "",
    canHandlePrices: data.canHandlePrices === true,
    canSeeCustomerContact: data.canSeeCustomerContact !== false,
  };
  const res = await todayForWorker({ subAccountId: input.subAccountId, workerId: id });
  return {
    visits: res.visits.map((v) => projectVisit(v, link)),
    prices: link.canHandlePrices,
    contact: link.canSeeCustomerContact,
  };
}

export interface AgencyCrewRow {
  workerId: string;
  subAccountId: string;
  subAccountName: string;
  name: string;
  kind: string;
  status: string;
  source: "member" | "crew-app";
  portalStatus: string | null;
  contact: string;
  personId: string | null;
}

export async function listAgencyCrew(agencyId: string): Promise<AgencyCrewRow[]> {
  const db = getAdminDb();
  const [workers, subs] = await Promise.all([
    db.collection("fieldWorkers").where("agencyId", "==", agencyId).get(),
    db.collection("subAccounts").where("agencyId", "==", agencyId).get(),
  ]);
  const names = new Map(subs.docs.map((d) => [d.id, (d.data().name as string) ?? d.id]));
  return workers.docs
    .map((d) => {
      const w = d.data();
      return {
        workerId: d.id,
        subAccountId: w.subAccountId as string,
        subAccountName: names.get(w.subAccountId as string) ?? "",
        name: (w.name as string) ?? "",
        kind: (w.kind as string) ?? "employee",
        status: (w.status as string) ?? "active",
        source: w.memberUid ? ("member" as const) : ("crew-app" as const),
        portalStatus: w.memberUid ? null : ((w.portalStatus as string | undefined) ?? "none"),
        contact: ((w.phone as string) || (w.email as string) || "") as string,
        personId: (w.personId as string | null | undefined) ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
