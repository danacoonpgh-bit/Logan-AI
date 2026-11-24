/** Tax maths for a booking, in minor units. Shared by the server (which decides) and the page (which only shows). */

export interface BookingTaxRate {
  percent: number;
  inclusive: boolean;
}

export interface BookingTotals {
  /** Price before tax. */
  netMinor: number;
  taxMinor: number;
  /** What the customer pays. */
  totalMinor: number;
}

/** `priceMinor` is the sum of the prices as typed: with tax included it already contains the tax, otherwise it is before tax. */
export function bookingTotals(priceMinor: number, tax: BookingTaxRate | null): BookingTotals {
  const price = Math.max(0, Math.round(priceMinor));
  if (!tax || !(tax.percent > 0)) return { netMinor: price, taxMinor: 0, totalMinor: price };
  const rate = tax.percent / 100;
  if (tax.inclusive) {
    const taxMinor = Math.round(price - price / (1 + rate));
    return { netMinor: price - taxMinor, taxMinor, totalMinor: price };
  }
  const taxMinor = Math.round(price * rate);
  return { netMinor: price, taxMinor, totalMinor: price + taxMinor };
}
