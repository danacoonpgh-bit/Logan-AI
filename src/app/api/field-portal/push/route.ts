import { json, withFieldPerson } from "@/lib/field-portal/guard";
import { sha256 } from "@/lib/field-portal/crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { isAllowedPushEndpoint } from "@/lib/push/endpoint";

export const dynamic = "force-dynamic";

const MAX_DEVICES = 10;

function validSubscription(sub: unknown): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s.endpoint !== "string" || !s.keys) return null;
  const { p256dh, auth } = s.keys;
  if (s.endpoint.length > 2048 || !isAllowedPushEndpoint(s.endpoint)) return null;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (p256dh.length > 512 || auth.length > 512) return null;
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

export const POST = withFieldPerson(async ({ request, session }) => {
  const body = (await request.json().catch(() => null)) as
    | { subscription?: unknown; userAgent?: unknown }
    | null;
  const sub = validSubscription(body?.subscription);
  if (!sub) return json({ error: "Invalid subscription" }, 400);

  const col = getAdminDb().collection(`fieldPersons/${session.personId}/pushSubscriptions`);
  const existing = await col.get();
  const id = sha256(sub.endpoint);
  if (existing.size >= MAX_DEVICES && !existing.docs.some((d) => d.id === id)) {
    const oldest = existing.docs.sort(
      (a, b) => (a.data().createdAtMs ?? 0) - (b.data().createdAtMs ?? 0),
    )[0];
    await oldest.ref.delete();
  }
  await col.doc(id).set({
    endpoint: sub.endpoint,
    keys: sub.keys,
    deviceId: session.deviceId,
    userAgent: typeof body?.userAgent === "string" ? body.userAgent.slice(0, 300) : null,
    createdAtMs: Date.now(),
  });
  return json({ ok: true });
});

export const DELETE = withFieldPerson(async ({ request, session }) => {
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof body?.endpoint !== "string") return json({ error: "Invalid request" }, 400);
  await getAdminDb()
    .doc(`fieldPersons/${session.personId}/pushSubscriptions/${sha256(body.endpoint)}`)
    .delete();
  return json({ ok: true });
});
