import "server-only";

import { NextResponse } from "next/server";
import {
  requireFieldServicesAdmin,
  requireFieldServicesMember,
  type FieldServicesAccess,
} from "@/lib/field-services/gate";
import { requireTerritoryOfDoc } from "@/lib/field-services/territory";
import { resolveActor, type FieldActor } from "@/lib/server/field-access";

type Collection = Parameters<typeof requireTerritoryOfDoc>[1];

export interface DocContext {
  guard: FieldServicesAccess;
  actor: FieldActor;
}

export async function docContext(
  request: Request,
  subAccountId: string,
  collection: Collection,
  id: string,
  opts: { adminOnly?: boolean } = {},
): Promise<DocContext | NextResponse> {
  const guard = opts.adminOnly
    ? await requireFieldServicesAdmin(request, subAccountId)
    : await requireFieldServicesMember(request, subAccountId);
  if (guard instanceof NextResponse) return guard;
  const actor = await resolveActor(
    subAccountId,
    guard.access.uid,
    guard.access.subAccountRole,
  );
  const outOfScope = await requireTerritoryOfDoc(guard, collection, id, actor.workerId);
  if (outOfScope) return outOfScope;
  return { guard, actor };
}

export async function requireOffice(
  guard: FieldServicesAccess,
): Promise<NextResponse | null> {
  const actor = await resolveActor(
    guard.access.subAccountId,
    guard.access.uid,
    guard.access.subAccountRole,
  );
  return actor.isOffice
    ? null
    : NextResponse.json({ error: "Only the office can do this." }, { status: 403 });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = (await request.json()) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function badJson(): NextResponse {
  return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
}
