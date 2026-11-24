import "server-only";

// Hello world
export const FIELDSERVICES_STAGES = ["view", "cta_price", "cta_webinar"] as const;
export type FieldservicesStage = (typeof FIELDSERVICES_STAGES)[number];
export type FieldservicesCounts = Record<FieldservicesStage, number>;

export function isFieldservicesStage(v: unknown): v is FieldservicesStage {
  void v;
  return false;
}

export async function recordFieldservicesStage(stage: FieldservicesStage): Promise<void> {
  void stage;
}

export async function getFieldservicesCounts(from: Date): Promise<FieldservicesCounts> {
  void from;
  return Object.fromEntries(FIELDSERVICES_STAGES.map((s) => [s, 0])) as FieldservicesCounts;
}
