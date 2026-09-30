/**
 * Shared DTO types for the `patient` module's UI and API transforms.
 *
 * These mirror the response shapes documented in `api/openapi.ts`. They live in one place
 * so a route's `transformItem` and the component that renders it cannot drift — a renamed
 * field then fails to compile instead of rendering as `undefined`.
 */

export type PatientStatusValue = 'active' | 'archived'

/**
 * A reference to a record owned by another module, as the API returns it.
 *
 * `isAvailable: false` means the record still resolves in scope but is inactive or
 * soft-deleted, so the UI shows its name with an "unavailable" marker: existing history
 * stays legible while the reference cannot be selected again. `id` is present because a
 * form needs it as a value; it is never rendered.
 */
export type PatientReference = {
  id: string
  name: string
  isAvailable: boolean
}

export type PatientListItem = {
  id: string
  patientNumber: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
  email: string | null
  phone: string | null
  ownerTeamMemberId: string | null
  owner: PatientReference | null
  status: PatientStatusValue
  createdAt: string | null
  /** The optimistic-lock token. Dropping it silently disables conflict detection. */
  updatedAt: string | null
  nextVisit?: PatientNextVisit | null
} & Record<`cf_${string}`, unknown>

export type PatientNextVisit = {
  startsAt: string
  timeZone: string
  resourceNameSnapshot: string | null
  confirmedAt: string | null
}

export type PatientDetailItem = PatientListItem & {
  birthDate: string | null
  description: string | null
  archivedAt: string | null
}

export type PatientAddressItem = {
  id: string
  patientId: string
  name: string | null
  purpose: string | null
  companyName: string | null
  addressLine1: string
  addressLine2: string | null
  buildingNumber: string | null
  flatNumber: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  latitude: number | null
  longitude: number | null
  isPrimary: boolean
  updatedAt: string | null
}

export type PatientContactItem = {
  id: string
  patientId: string
  customerEntityId: string
  person: PatientReference | null
  isGuardian: boolean
  isContact: boolean
  isPayer: boolean
  isPrimaryContact: boolean
  relationshipLabel: string | null
  updatedAt: string | null
}

export type PatientDiagnosisStatusValue = 'active' | 'superseded' | 'voided'

export type PatientDiagnosisItem = {
  id: string
  patientId: string
  title: string
  description: string
  diagnosedOn: string
  code: string | null
  codeSystem: string | null
  codeVersion: string | null
  author: PatientReference | null
  authorUserId: string
  supersedesId: string | null
  supersededById: string | null
  status: PatientDiagnosisStatusValue
  voidReason: string | null
  voidedAt: string | null
  updatedAt: string | null
}

export type PatientDocumentLinkState = 'pending_create' | 'linked' | 'abandoned'

export type PatientDocumentLinkItem = {
  id: string
  patientId: string
  documentId: string
  state: PatientDocumentLinkState
  /** `null` when the caller does not pass the documents module's own access check. */
  title: string | null
  isSharedWithOtherPatients: boolean
  updatedAt: string | null
}

export type PatientAttachmentLinkItem = {
  id: string
  patientId: string
  diagnosisId: string | null
  attachmentId: string
  fileName: string | null
  state: 'active' | 'detached'
  updatedAt: string | null
}

export type PatientVisitStatusValue = 'planned' | 'completed' | 'cancelled' | 'no_show'

export type PatientVisitServiceItem = {
  id: string
  productId: string
  title: string
  sku: string | null
  isAvailable: boolean
  position: number
}

export type PatientVisitItem = {
  id: string
  patientId: string
  patientName: string | null
  teamMemberId: string
  teamMemberName: string
  resourceId: string | null
  resourceName: string | null
  startsAt: string
  endsAt: string | null
  timeZone: string
  description?: string | null
  status: PatientVisitStatusValue
  confirmedAt: string | null
  conflictOverrideAt?: string | null
  conflictOverrideByUserId?: string | null
  conflictOverrideByUserName?: string | null
  conflictOverrideCodes?: string[] | null
  /** Present only for an explicit detail lookup. */
  conflictOverrideReason?: string | null
  isConfirmed: boolean
  confirmationApplicable: boolean
  isSettled: boolean
  settledAt: string | null
  services: PatientVisitServiceItem[]
  updatedAt: string
}

/** The standard paged envelope every list route in this module returns. */
export type PatientPagedResponse<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  totalIsCapped?: boolean
}
