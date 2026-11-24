import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

export interface CrewAppStatus {
  /** ISO time of the last time they opened the app, or null if never. */
  lastSeenAt: string | null;
  /** Whether at least one phone has alerts turned on. Null before they have joined. */
  alerts: boolean | null;
  /** The open invite ran out before they used it. */
  inviteExpired: boolean;
}

function ms(v: unknown): number | null {
  return v instanceof Timestamp ? v.toMillis() : null;
}

/** Crew app activity for the people in this workspace who use the crew app. Office only. */
export async function crewAppStatus(subAccountId: string): Promise<Record<string, CrewAppStatus>> {
  const db = getAdminDb();
  const workers = (await db.collection("fieldWorkers").where("subAccountId", "==", subAccountId).get()).docs.filter(
    (d) => d.data().status === "active",
  );
  const out: Record<string, CrewAppStatus> = {};
  await Promise.all(
    workers.map(async (d) => {
      const w = d.data();
      const personId = typeof w.personId === "string" ? w.personId : null;
      let lastSeenAt: string | null = null;
      let alerts: boolean | null = null;
      if (personId && w.portalStatus === "active") {
        const [person, subs] = await Promise.all([
          db.doc(`fieldPersons/${personId}`).get(),
          db.collection(`fieldPersons/${personId}/pushSubscriptions`).limit(1).get(),
        ]);
        // A person record shared with another business is not this business's crew app yet.
        if (person.data()?.subAccountId === subAccountId) {
          const t = ms(person.data()?.lastActiveAt);
          lastSeenAt = t ? new Date(t).toISOString() : null;
          alerts = !subs.empty;
        }
      }
      let inviteExpired = false;
      if (w.portalStatus === "invited") {
        const open = await db
          .collection("fieldInvites")
          .where("workerId", "==", d.id)
          .where("consumedAt", "==", null)
          .get();
        const expiries = open.docs.map((i) => ms(i.data().expiresAt) ?? 0);
        inviteExpired = expiries.length === 0 || Math.max(...expiries) < Date.now();
      }
      out[d.id] = { lastSeenAt, alerts, inviteExpired };
    }),
  );
  return out;
}
