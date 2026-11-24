import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { portalSecretConfigured } from "@/lib/field-portal/crypto";
import { WORKSPACE_ID } from "@/lib/field-portal/identity";
import { readSession, type PortalSession } from "@/lib/server/field-portal-session-service";
import { SESSION_SLIDING_MS } from "@/types/field-portal";

const PROD = process.env.NODE_ENV === "production";
const COOKIE_PREFIX = PROD ? "__Host-ls_field_" : "ls_field_";

/** One cookie per workspace, so signing in to one business never touches another. */
export function fieldCookieName(subAccountId: string): string {
  return `${COOKIE_PREFIX}${subAccountId}`;
}

export function sessionCookieHeader(token: string, subAccountId: string): string {
  const maxAge = Math.floor(SESSION_SLIDING_MS / 1000);
  return `${fieldCookieName(subAccountId)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD ? "; Secure" : ""}`;
}

export function clearCookieHeader(subAccountId: string): string {
  return `${fieldCookieName(subAccountId)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? "; Secure" : ""}`;
}

/** Which workspace's crew app a request is for. The app sends it on every call; the cookie is still what proves who they are. */
export function workspaceOf(request: Request): string | null {
  const v = request.headers.get("x-field-sa");
  if (v) return WORKSPACE_ID.test(v) ? v : null;
  // Images and links cannot send the header, so only photo reads take it from the address.
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const m = /^\/api\/field-portal\/([^/]+)\/visits\/[^/]+\/photos\//.exec(new URL(request.url).pathname);
  return m && WORKSPACE_ID.test(m[1]) ? m[1] : null;
}

export function json(body: unknown, status = 200, cookie?: string): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  if (cookie) res.headers.append("Set-Cookie", cookie);
  return res;
}

/** Prefers the platform's own client-IP header, then the last proxy-added hop. */
export function portalClientIp(request: Request): string {
  const vercel = request.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0]!.trim();
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",");
    return hops[hops.length - 1]!.trim();
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** State-changing requests must come from our own origin. */
export function sameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export async function currentSession(subAccountId: string): Promise<PortalSession | null> {
  if (!portalSecretConfigured() || !WORKSPACE_ID.test(subAccountId)) return null;
  const jar = await cookies();
  const session = await readSession(jar.get(fieldCookieName(subAccountId))?.value);
  // An account only works in its own workspace.
  return session && session.subAccountId === subAccountId ? session : null;
}

interface Ctx<P> {
  request: Request;
  session: PortalSession;
  subAccountId: string;
  params: P;
}

/** Every protected portal route goes through this. It ignores any staff login headers. */
export function withFieldPerson<P = Record<string, never>>(
  handler: (ctx: Ctx<P>) => Promise<Response>,
) {
  return async (request: Request, routeCtx?: { params: Promise<P> }): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
      return json({ error: "Forbidden" }, 403);
    }
    const subAccountId = workspaceOf(request);
    if (!subAccountId) return json({ error: "Sign in required" }, 401);
    let session: PortalSession | null;
    try {
      session = await currentSession(subAccountId);
    } catch (err) {
      console.error("[field-portal] session check failed", err);
      return json({ error: "Unavailable" }, 503);
    }
    if (!session) return json({ error: "Sign in required" }, 401);
    const params = (routeCtx ? await routeCtx.params : {}) as P;
    const res = await handler({ request, session, subAccountId, params });
    res.headers.set("Cache-Control", "no-store");
    if (session.renewedToken) res.headers.append("Set-Cookie", sessionCookieHeader(session.renewedToken, subAccountId));
    return res;
  };
}

/** For the few routes that must work before sign-in. Same-origin only; callers do their own limiting. */
export function publicPortalRoute(
  handler: (request: Request) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
    if (!portalSecretConfigured()) return json({ error: "Unavailable" }, 503);
    const res = await handler(request);
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
}
