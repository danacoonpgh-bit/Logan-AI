const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
  "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function currencyExponent(currency: string): number {
  const c = (currency ?? "").toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

export function minorToUnit(currency: string, minor: number): number {
  const e = currencyExponent(currency);
  return Math.round(minor) / 10 ** e;
}

export function unitToMinor(currency: string, unit: number): number {
  const e = currencyExponent(currency);
  return Math.round(unit * 10 ** e);
}

export function parseDecimalInput(text: string): number | null {
  const t = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function formatMinor(currency: string, minor: number): string {
  return minorToUnit(currency, minor).toFixed(currencyExponent(currency));
}

/** Always shows which currency, for text a customer reads. */
export function formatMoneyCode(currency: string, minor: number): string {
  const amount = minorToUnit(currency, minor);
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(currencyExponent(currency))} ${currency.toUpperCase()}`;
  }
}

/** The workspace's one Field Services currency, or USD until a workspace chooses. */
export function workspaceCurrencyOf(config: { currency?: string } | null | undefined): string {
  return config?.currency && /^[A-Z]{3}$/.test(config.currency) ? config.currency : "USD";
}
