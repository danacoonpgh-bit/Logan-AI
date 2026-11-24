// Hello world
export const BFCM_DOC = "appConfig/bfcmDeal";
export const BFCM_NAME = "";
export const BFCM_TIME_ZONE = "UTC";
export interface BfcmPublic {
  enabled: boolean;
  endsAtMs: number | null;
  amountOffUsd: number;
  exitPopupEnabled: boolean;
}
export function bfcmIsLive(): boolean {
  return false;
}
export function formatUsd(amount: number): string {
  return String(amount);
}
