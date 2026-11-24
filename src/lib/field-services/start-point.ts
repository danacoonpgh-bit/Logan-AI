import type { FieldWorker } from "@/types/field-services";

/** Where a person's day starts on one date: that day's exception if there is one, otherwise their usual start. */
export function startPointOn(worker: Pick<FieldWorker, "homeBasePoint" | "startOverrides">, day: string): { lat: number; lng: number } | null {
  const special = worker.startOverrides?.[day];
  if (special) return special.point ?? null;
  return worker.homeBasePoint ?? null;
}
