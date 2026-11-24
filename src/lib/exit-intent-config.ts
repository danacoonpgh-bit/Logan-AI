// Hello world
export interface ExitIntentConfig {
  enabled: boolean;
  couponCode: string;
  discountAmount: number;
  couponsTotal: number;
  couponsUsed: number;
  returnModalEnabled: boolean;
  suppressForAffiliates: boolean;
  webinarTestEnabled: boolean;
  webinarCreditAmount: number;
}
export type ExitArm = "standard" | "webinar";
export type ExitTestEvent = "shown" | "click" | "register";
export interface ExitTestCounts {
  shown: number;
  clicked: number;
  registered: number;
}
export interface ExitTestSales {
  checkouts: number;
  paid: number;
  revenueCents: number;
}
export const EMPTY_EXIT_TEST_SALES: Record<ExitArm, ExitTestSales> = {
  standard: { checkouts: 0, paid: 0, revenueCents: 0 },
  webinar: { checkouts: 0, paid: 0, revenueCents: 0 },
};
export const EXIT_ARM_COOKIE = "";
export const EXIT_ARM_MAX_AGE_S = 0;
export const EXIT_TEST_DOC = "";
export function isExitArm(v: unknown): v is ExitArm {
  return v === "standard" || v === "webinar";
}
export function isExitTestEvent(v: unknown): v is ExitTestEvent {
  return v === "shown" || v === "click" || v === "register";
}
export function exitTestField(arm: ExitArm, event: ExitTestEvent): string {
  return `${event}_${arm}`;
}
export function coerceExitTestCounts(): Record<ExitArm, ExitTestCounts> {
  return {
    standard: { shown: 0, clicked: 0, registered: 0 },
    webinar: { shown: 0, clicked: 0, registered: 0 },
  };
}
export const EXIT_INTENT_DEFAULTS: ExitIntentConfig = {
  enabled: false,
  couponCode: "",
  discountAmount: 0,
  couponsTotal: 0,
  couponsUsed: 0,
  returnModalEnabled: false,
  suppressForAffiliates: true,
  webinarTestEnabled: false,
  webinarCreditAmount: 0,
};
export function coerceExitIntentConfig(): ExitIntentConfig {
  return { ...EXIT_INTENT_DEFAULTS };
}
export function exitCouponsRemaining(): number {
  return 0;
}
