import {
  collection,
  onSnapshot,
  query,
  where,
  type QueryConstraint,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import { NOOP_UNSUB, territoryQueryPlan } from "@/lib/firestore/territory-query";
import type { Product } from "@/types/products";
import type {
  FieldWorker,
  Job,
  ServiceArea,
  ServiceRequest,
  Visit,
} from "@/types/field-services";

export function subscribeToFieldWorkers(
  subAccountId: string,
  callback: (workers: FieldWorker[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    query(
      collection(getFirebaseDb(), "fieldWorkers"),
      where("subAccountId", "==", subAccountId),
    ),
    (snap) =>
      callback(
        snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<FieldWorker, "id">),
        })),
      ),
    (err) => onError?.(err),
  );
}

export function subscribeToServiceAreas(
  subAccountId: string,
  callback: (areas: ServiceArea[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    collection(getFirebaseDb(), `subAccounts/${subAccountId}/serviceAreas`),
    (snap) =>
      callback(
        snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<ServiceArea, "id">),
        })),
      ),
    (err) => onError?.(err),
  );
}

export function subscribeToServices(
  subAccountId: string,
  callback: (services: Product[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    query(
      collection(getFirebaseDb(), "products"),
      where("subAccountId", "==", subAccountId),
    ),
    (snap) =>
      callback(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Product, "id">) }))
          .filter((p) => p.kind === "service" && p.active !== false),
      ),
    (err) => onError?.(err),
  );
}

function millis(v: unknown): number {
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : 0;
}

function subscribeScoped<T extends { id: string }>(
  collectionName: string,
  subAccountId: string,
  territoryFilter: string[] | null | undefined,
  sort: (a: T, b: T) => number,
  callback: (rows: T[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const plan = territoryQueryPlan(territoryFilter);
  if (plan.mode === "empty") {
    callback([]);
    return NOOP_UNSUB;
  }
  const constraints: QueryConstraint[] = [where("subAccountId", "==", subAccountId)];
  if (plan.mode === "in") constraints.push(plan.constraint);
  return onSnapshot(
    query(collection(getFirebaseDb(), collectionName), ...constraints),
    (snap) =>
      callback(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as object) }) as T)
          .sort(sort),
      ),
    (err) => onError?.(err),
  );
}

export function subscribeToServiceRequests(
  subAccountId: string,
  territoryFilter: string[] | null | undefined,
  callback: (rows: ServiceRequest[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return subscribeScoped<ServiceRequest>(
    "serviceRequests",
    subAccountId,
    territoryFilter,
    (a, b) => millis(b.createdAt) - millis(a.createdAt),
    callback,
    onError,
  );
}

export function subscribeToJobs(
  subAccountId: string,
  territoryFilter: string[] | null | undefined,
  callback: (rows: Job[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return subscribeScoped<Job>(
    "jobs",
    subAccountId,
    territoryFilter,
    (a, b) => millis(b.createdAt) - millis(a.createdAt),
    callback,
    onError,
  );
}

export function subscribeToVisits(
  subAccountId: string,
  territoryFilter: string[] | null | undefined,
  callback: (rows: Visit[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return subscribeScoped<Visit>(
    "visits",
    subAccountId,
    territoryFilter,
    (a, b) => millis(a.scheduledStart) - millis(b.scheduledStart),
    callback,
    onError,
  );
}
