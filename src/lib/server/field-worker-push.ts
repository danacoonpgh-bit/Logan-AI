import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { sendPushToUser } from "@/lib/push/send";
import { sendPushToFieldPerson } from "@/lib/push/send-field-person";

/** A push to one worker, on their workspace login or their crew phone app. Never throws. */
export async function pushToWorker(
  workerId: string,
  msg: { title: string; body: string; tag: string },
): Promise<void> {
  try {
    const w = (await getAdminDb().doc(`fieldWorkers/${workerId}`).get()).data();
    if (!w || w.status !== "active") return;
    // A member who has the crew app on gets that alert instead of a second one from the workspace.
    const delivered =
      w.personId && w.portalStatus === "active"
        ? await sendPushToFieldPerson({
            personId: w.personId as string,
            title: msg.title,
            body: msg.body,
            url: `/field/${w.subAccountId}`,
            tag: msg.tag,
          })
        : 0;
    if (w.memberUid && delivered === 0) {
      await sendPushToUser({
        uid: w.memberUid as string,
        title: msg.title,
        body: msg.body,
        url: `/sa/${w.subAccountId}/field-services/today`,
        tag: msg.tag,
      });
    }
  } catch (err) {
    console.warn("[field-worker-push] failed", err);
  }
}
