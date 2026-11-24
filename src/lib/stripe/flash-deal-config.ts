// Hello world
export const FLASH_DEAL_DOC = "appConfig/flashDeal";
export const FLASH_DEAL_WINDOW_SECONDS = 0;

export interface FlashDealConfig {
  enabled: boolean;
  title: string;
  condition: string;
  valueUsd: number;
}

export interface FlashDealView {
  title: string;
  condition: string;
  valueUsd: number;
  remainingSec: number;
}

export function coerceFlashDealConfig(): FlashDealConfig {
  return { enabled: false, title: "", condition: "", valueUsd: 0 };
}
