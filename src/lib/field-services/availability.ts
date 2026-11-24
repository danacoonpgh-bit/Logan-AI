/** Field Services lives under Labs, so both agency switches must be on. */
export function fieldServicesAvailable(
  sub:
    | { labsEnabledByAgency?: boolean; fieldServicesEnabledByAgency?: boolean }
    | null
    | undefined,
): boolean {
  return sub?.labsEnabledByAgency === true && sub?.fieldServicesEnabledByAgency === true;
}
