/** "45 min", "4 h" or "1 h 30 min" for a length in minutes. */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The time a job is expected to take: each service on its lines times its quantity, added up. Extra work the customer
 * approved later is left out. Zero when no line is a service with a time allowance.
 */
export function jobAllowanceMinutes(
  lines: { productId?: string | null; quantity?: number; approvalId?: string | null; durationMinutes?: number | null }[],
  services: { id: string; durationMinutes?: number | null }[],
): number {
  let total = 0;
  for (const l of lines) {
    if (l.approvalId || !l.productId) continue;
    const minutes =
      typeof l.durationMinutes === "number" && l.durationMinutes > 0
        ? l.durationMinutes
        : services.find((sv) => sv.id === l.productId)?.durationMinutes;
    if (typeof minutes === "number" && minutes > 0) total += minutes * Math.max(1, Math.round(l.quantity ?? 1));
  }
  return Math.min(total, 1_440);
}
