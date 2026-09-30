export type PatientSearchScope = {
  tenantId: string | null
  organizationId: string | null
}

/**
 * Search helpers run before the CRUD factory's final list guard, so they need their own
 * explicit two-part scope check before touching an index or decrypting a row.
 */
export function hasCompletePatientSearchScope(
  scope: PatientSearchScope,
): scope is { tenantId: string; organizationId: string } {
  return Boolean(scope.tenantId && scope.organizationId)
}
