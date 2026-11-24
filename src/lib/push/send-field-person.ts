import "server-only";

import webpush from "web-push";
import { getAdminDb } from "@/lib/firebase/admin";
import { pushIsConfigured, getVapidKeys } from "@/lib/push/config";
import { CUSTOM_BRAND } from "@/config/landing";

/** Pushes to a crew-app person's phones. Returns how many devices accepted it. Never throws. */
export async function sendPushToFieldPerson(input: {
  personId: string;
  title: string;
  body: string;
  url: string;
  tag?: string;
}): Promise<number> {
  try {
    if (!pushIsConfigured()) return 0;
    const { publicKey, privateKey } = getVapidKeys();
    const subject = `mailto:${CUSTOM_BRAND.supportEmail}`;
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      url: input.url,
      tag: input.tag,
    });
    const subs = await getAdminDb().collection(`fieldPersons/${input.personId}/pushSubscriptions`).get();
    const results = await Promise.all(
      subs.docs.map(async (doc) => {
        const sub = doc.data();
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint as string, keys: sub.keys as { p256dh: string; auth: string } },
            payload,
            { vapidDetails: { subject, publicKey, privateKey }, timeout: 8_000 },
          );
          return 1;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) await doc.ref.delete().catch(() => {});
          else console.warn("[push] crew delivery failed", err);
          return 0;
        }
      }),
    );
    return results.reduce<number>((a, b) => a + b, 0);
  } catch (err) {
    console.warn("[push] sendPushToFieldPerson failed", err);
    return 0;
  }
}
