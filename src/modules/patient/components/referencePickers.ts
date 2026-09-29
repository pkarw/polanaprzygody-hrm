"use client"
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import type { CrudFieldOption } from '@open-mercato/ui/backend/CrudForm'

/**
 * Option sources for the two cross-module references this module stores.
 *
 * Both call the OWNING module's existing list endpoint rather than a new patient route.
 * That is the spec's rule and it is a security property, not tidiness: `GET
 * /api/staff/team-members` is gated on `staff.view` and `GET /api/customers/people` on
 * `customers.people.view`, so an operator who cannot see staff or CRM people gets an empty
 * or refused picker instead of a list this module would otherwise have handed them. A
 * patient-owned "options" route would have to re-implement those checks, and would become
 * the place they drift.
 *
 * `patient.patients.manage` therefore does not by itself let anyone browse staff or CRM.
 *
 * Both sources request only active records: the spec allows an existing, since-deactivated
 * reference to stay readable but forbids selecting one afresh. The already-selected value
 * is resolved separately by `resolveLabel`, which does not filter on activity — that is how
 * a historical carer still renders its name in the form it is stored in.
 */

type StaffTeamMemberListItem = {
  id?: unknown
  displayName?: unknown
  display_name?: unknown
}

type CrmPersonListItem = {
  id?: unknown
  display_name?: unknown
  displayName?: unknown
}

type ListResponse<T> = { items?: T[] }

/** Reads whichever casing the host route used, so a response-shape change is not silent. */
function readDisplayName(item: { displayName?: unknown; display_name?: unknown }): string | null {
  if (typeof item.displayName === 'string' && item.displayName.length > 0) return item.displayName
  if (typeof item.display_name === 'string' && item.display_name.length > 0) return item.display_name
  return null
}

function toOptions(items: Array<{ id?: unknown; displayName?: unknown; display_name?: unknown }>): CrudFieldOption[] {
  const options: CrudFieldOption[] = []
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : null
    const label = readDisplayName(item)
    // A record without a resolvable name is skipped rather than listed by its uuid: the
    // spec forbids showing identifiers in the UI, and an unlabelled option is unusable.
    if (id && label) options.push({ value: id, label })
  }
  return options
}

const OPTION_PAGE_SIZE = 50

/** Active staff team members, for the optional lead-carer field. */
export async function loadTeamMemberOptions(query?: string): Promise<CrudFieldOption[]> {
  const params = new URLSearchParams({ pageSize: String(OPTION_PAGE_SIZE), isActive: 'true' })
  if (query && query.trim().length > 0) params.set('search', query.trim())
  const data = await readApiResultOrThrow<ListResponse<StaffTeamMemberListItem>>(
    `/api/staff/team-members?${params.toString()}`,
  )
  return toOptions(data?.items ?? [])
}

/**
 * Resolves one already-stored team member id to its label.
 *
 * Deliberately does NOT pass `isActive=true`: this is the read path for a value the record
 * already holds, and a carer who left must still render by name rather than silently
 * becoming a blank field. The value's id is returned unchanged when it cannot be resolved,
 * so the caller can decide how to present an unavailable reference.
 */
export async function resolveTeamMemberLabel(id: string): Promise<string> {
  if (!id) return ''
  const data = await readApiResultOrThrow<ListResponse<StaffTeamMemberListItem>>(
    `/api/staff/team-members?ids=${encodeURIComponent(id)}&pageSize=1`,
  )
  const first = (data?.items ?? [])[0]
  return (first && readDisplayName(first)) || id
}

/**
 * Active CRM people, for the contact-link picker.
 *
 * The value is the `customer_entity` id — what the CRM list returns as `id` and what the
 * CRM API operates on. The `customer_people` profile carries a different uuid for the same
 * person, and storing that one instead is the exact confusion the spec calls out.
 */
export async function loadCrmPersonOptions(query?: string): Promise<CrudFieldOption[]> {
  const params = new URLSearchParams({ pageSize: String(OPTION_PAGE_SIZE), isActive: 'true' })
  if (query && query.trim().length > 0) params.set('search', query.trim())
  const data = await readApiResultOrThrow<ListResponse<CrmPersonListItem>>(
    `/api/customers/people?${params.toString()}`,
  )
  return toOptions(data?.items ?? [])
}
