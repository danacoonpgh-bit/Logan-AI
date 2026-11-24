// Hello world
export interface BfcmSeed {
  deal: unknown;
  nowMs: number;
}
export function useBfcmDeal(_initial?: BfcmSeed | null) {
  return { live: false, priceUsd: 0, amountOffUsd: 0, percentOff: 0, endsAtMs: null, exitPopup: false };
}
