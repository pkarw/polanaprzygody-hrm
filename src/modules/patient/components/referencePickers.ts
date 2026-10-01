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
  /**
   * Specializations, as the staff module already stores and projects them.
   *
   * `tags` is deliberately the source rather than the `cf_polana_specializations` custom
   * field: both hold the same values (see `polana_bootstrap/lib/staffBootstrap.ts`, which
   * writes them to each), but `tags` is a first-class column the host's own list route
   * already returns. Reading the custom field instead would mean a second request per
   * picker open, or asking the host route for a projection it does not offer.
   */
  tags?: unknown
}

type CrmPersonListItem = {
  id?: unknown
  display_name?: unknown
  displayName?: unknown
  primary_email?: unknown
  primary_phone?: unknown
}

/** The contact details copied from a guardian when the patient's own fields are still empty. */
export type CrmPersonContact = {
  id: string
  name: string | null
  email: string | null
  phone: string | null
}

type ListResponse<T> = { items?: T[] }

type PatientOptionItem = {
  id?: unknown
  displayName?: unknown
  patientNumber?: unknown
  status?: unknown
}

type ResourceOptionItem = {
  id?: unknown
  name?: unknown
  is_active?: unknown
  isActive?: unknown
}

type ProductOptionItem = {
  id?: unknown
  title?: unknown
  sku?: unknown
  is_active?: unknown
  isActive?: unknown
}

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

/** Keeps only non-empty strings, so a stray null in the jsonb column cannot reach the label. */
function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

/**
 * Renders a team member as "Name — specialization, specialization".
 *
 * Choosing who leads a patient's care is a clinical decision, and a list of bare names does
 * not support it: two names tell the operator nothing about which of them treats this
 * condition. The separator is an em dash so the name stays readable when a member has no
 * specializations recorded, in which case the label is just the name.
 *
 * The list is capped at three with a "+n" remainder. An uncapped join turns a member with a
 * dozen tags into a label that pushes the rest of the option out of the control at 360 px.
 */
function composeTeamMemberLabel(name: string, tags: string[]): string {
  if (tags.length === 0) return name
  const shown = tags.slice(0, 3)
  const remainder = tags.length - shown.length
  const specializations = remainder > 0 ? `${shown.join(', ')} +${remainder}` : shown.join(', ')
  return `${name} — ${specializations}`
}

function toTeamMemberOptions(items: StaffTeamMemberListItem[]): CrudFieldOption[] {
  const options: CrudFieldOption[] = []
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : null
    const name = readDisplayName(item)
    if (!id || !name) continue
    options.push({ value: id, label: composeTeamMemberLabel(name, readTags(item.tags)) })
  }
  return options
}

const OPTION_PAGE_SIZE = 50

function toNamedOption(id: unknown, name: unknown, description?: unknown): CrudFieldOption | null {
  if (typeof id !== 'string' || typeof name !== 'string' || name.trim().length === 0) return null
  const detail = typeof description === 'string' && description.trim().length > 0
    ? description.trim()
    : null
  return { value: id, label: detail ? `${name.trim()} — ${detail}` : name.trim() }
}

export async function loadPatientOptions(query?: string): Promise<CrudFieldOption[]> {
  const params = new URLSearchParams({ pageSize: String(OPTION_PAGE_SIZE), status: 'active' })
  if (query?.trim()) params.set('search', query.trim())
  const data = await readApiResultOrThrow<ListResponse<PatientOptionItem>>(
    `/api/patient/patients?${params.toString()}`,
  )
  return (data.items ?? [])
    .map((item) => toNamedOption(item.id, item.displayName, item.patientNumber))
    .filter((item): item is CrudFieldOption => item !== null)
}

export async function resolvePatientLabel(id: string): Promise<string> {
  if (!id) return ''
  const data = await readApiResultOrThrow<ListResponse<PatientOptionItem>>(
    `/api/patient/patients?id=${encodeURIComponent(id)}&pageSize=1`,
  )
  const item = data.items?.[0]
  return (item && toNamedOption(item.id, item.displayName, item.patientNumber)?.label) || '—'
}

export async function loadResourceOptions(query?: string): Promise<CrudFieldOption[]> {
  const params = new URLSearchParams({ page: '1', pageSize: String(OPTION_PAGE_SIZE), isActive: 'true' })
  if (query?.trim()) params.set('search', query.trim())
  const data = await readApiResultOrThrow<ListResponse<ResourceOptionItem>>(
    `/api/resources/resources?${params.toString()}`,
  )
  return (data.items ?? [])
    .map((item) => toNamedOption(item.id, item.name))
    .filter((item): item is CrudFieldOption => item !== null)
}

export async function resolveResourceLabel(id: string): Promise<string> {
  if (!id) return ''
  const data = await readApiResultOrThrow<ListResponse<ResourceOptionItem>>(
    `/api/resources/resources?ids=${encodeURIComponent(id)}&pageSize=1`,
  )
  const item = data.items?.[0]
  return (item && toNamedOption(item.id, item.name)?.label) || '—'
}

export async function loadProductOptions(query?: string): Promise<CrudFieldOption[]> {
  const params = new URLSearchParams({ page: '1', pageSize: String(OPTION_PAGE_SIZE), isActive: 'true' })
  if (query?.trim()) params.set('search', query.trim())
  const data = await readApiResultOrThrow<ListResponse<ProductOptionItem>>(
    `/api/catalog/products?${params.toString()}`,
  )
  return (data.items ?? [])
    .map((item) => toNamedOption(item.id, item.title, item.sku))
    .filter((item): item is CrudFieldOption => item !== null)
}

export async function resolveProductLabel(id: string): Promise<string> {
  if (!id) return ''
  const data = await readApiResultOrThrow<ListResponse<ProductOptionItem>>(
    `/api/catalog/products?id=${encodeURIComponent(id)}&pageSize=1`,
  )
  const item = data.items?.[0]
  return (item && toNamedOption(item.id, item.title, item.sku)?.label) || '—'
}

export async function resolveProductAvailability(id: string): Promise<boolean> {
  if (!id) return false
  try {
    const data = await readApiResultOrThrow<ListResponse<ProductOptionItem>>(
      `/api/catalog/products?id=${encodeURIComponent(id)}&pageSize=1`,
    )
    const item = data.items?.[0]
    if (!item) return false
    return (item.isActive ?? item.is_active) === true
  } catch {
    // If the owner API cannot confirm the reference, the editor must not present it as
    // selectable/current. The visit's stored snapshot still keeps history readable.
    return false
  }
}

/**
 * Active staff team members, for the optional lead-carer field.
 *
 * Each option shows the member's specializations alongside their name, so the operator can
 * pick the right carer without leaving the form to look them up.
 */
export async function loadTeamMemberOptions(query?: string): Promise<CrudFieldOption[]> {
  const params = new URLSearchParams({ pageSize: String(OPTION_PAGE_SIZE), isActive: 'true' })
  if (query && query.trim().length > 0) params.set('search', query.trim())
  const data = await readApiResultOrThrow<ListResponse<StaffTeamMemberListItem>>(
    `/api/staff/team-members?${params.toString()}`,
  )
  return toTeamMemberOptions(data?.items ?? [])
}

/**
 * Resolves one already-stored team member id to its label.
 *
 * Deliberately does NOT pass `isActive=true`: this is the read path for a value the record
 * already holds, and a carer who left must still render by name rather than silently
 * becoming a blank field. An unresolved value is an em dash, never a raw UUID.
 */
export async function resolveTeamMemberLabel(id: string): Promise<string> {
  if (!id) return ''
  const data = await readApiResultOrThrow<ListResponse<StaffTeamMemberListItem>>(
    `/api/staff/team-members?ids=${encodeURIComponent(id)}&pageSize=1`,
  )
  const first = (data?.items ?? [])[0]
  if (!first) return '—'
  const name = readDisplayName(first)
  // Same label shape as the option list, so the selected value does not visibly change once
  // the field resolves it.
  return name ? composeTeamMemberLabel(name, readTags(first.tags)) : '—'
}

/**
 * Active CRM people, for the contact-link picker.
 *
 * The value is the `customer_entity` id — what the CRM list returns as `id` and what the
 * CRM API operates on. The `customer_people` profile carries a different uuid for the same
 * person, and storing that one instead is the exact confusion the spec calls out.
 */
export async function loadCrmPersonOptions(query?: string): Promise<CrudFieldOption[]> {
  const term = query?.trim() ?? ''

  const params = new URLSearchParams({ pageSize: String(OPTION_PAGE_SIZE) })
  if (term.length > 0) params.set('search', term)
  const data = await readApiResultOrThrow<ListResponse<CrmPersonListItem>>(
    `/api/customers/people?${params.toString()}`,
  )
  const options = toOptions(data?.items ?? [])
  if (term.length === 0 || options.length > 0) return options

  /**
   * Fallback: filter a page client-side when the server-side search returns nothing.
   *
   * `customers` encrypts `display_name`, so the people route's `$ilike` compares a plaintext
   * pattern against ciphertext and matches nothing unless the search index happens to be
   * populated for this tenant. The operator then types a name they can plainly see in the list
   * and gets no results — which is exactly the failure this repairs.
   *
   * Re-fetching WITHOUT `search` returns rows whose `display_name` the API has already decrypted,
   * so a case-insensitive substring test over the labels does what the operator expected. It is
   * bounded by the same page size: for a CRM larger than one page this narrows less than a
   * working index would, so the server search is still attempted first rather than replaced.
   */
  const unfiltered = await readApiResultOrThrow<ListResponse<CrmPersonListItem>>(
    `/api/customers/people?pageSize=${OPTION_PAGE_SIZE}`,
  )
  const needle = term.toLocaleLowerCase()
  return toOptions(unfiltered?.items ?? []).filter((option) =>
    option.label.toLocaleLowerCase().includes(needle),
  )
}

/**
 * Resolves one already-chosen CRM person to their display label.
 *
 * Needed by the combobox so a guardian picked earlier renders by name when the form is reopened,
 * instead of the control looking empty until the operator searches again.
 */
export async function resolveCrmPersonLabel(id: string): Promise<string> {
  if (!id) return ''
  const data = await readApiResultOrThrow<ListResponse<CrmPersonListItem>>(
    `/api/customers/people?ids=${encodeURIComponent(id)}&pageSize=1`,
  )
  const first = (data?.items ?? [])[0]
  return (first && readDisplayName(first)) || id
}

/** Reads a string field that may arrive in either casing, treating blank as absent. */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Fetches a CRM person's own contact details.
 *
 * Used to offer a guardian's email and phone as a starting point for a child's record. The spec
 * allows a parent's contact details to be entered deliberately into the patient's own fields, and
 * forbids fetching them dynamically *instead of* the patient's data — so this is a ONE-TIME copy
 * triggered by the operator selecting that person, written only into fields that are still empty,
 * and fully editable afterwards. Nothing re-reads it later, and no link is kept: the patient's
 * fields remain the patient's own.
 */
export async function resolveCrmPersonContact(id: string): Promise<CrmPersonContact | null> {
  if (!id) return null
  const data = await readApiResultOrThrow<ListResponse<CrmPersonListItem>>(
    `/api/customers/people?ids=${encodeURIComponent(id)}&pageSize=1`,
  )
  const first = (data?.items ?? [])[0]
  if (!first || typeof first.id !== 'string') return null
  return {
    id: first.id,
    name: readDisplayName(first),
    email: readText(first.primary_email),
    phone: readText(first.primary_phone),
  }
}

type DocumentListItem = { id?: unknown; title?: unknown }

/**
 * Documents this caller may already open.
 *
 * Candidates come from the documents module's own list endpoint, so the picker shows only
 * what that module's visibility rules already allow — this module does not get to widen
 * them. A refused or empty response is the correct outcome for an operator without access,
 * not an error, so it resolves to no options rather than throwing into the dialog.
 */
export async function loadDocumentOptions(query?: string): Promise<CrudFieldOption[]> {
  const params = new URLSearchParams({ pageSize: '50' })
  const term = query?.trim() ?? ''
  if (term.length > 0) params.set('search', term)
  try {
    const data = await readApiResultOrThrow<ListResponse<DocumentListItem>>(
      `/api/documents?${params.toString()}`,
    )
    const options: CrudFieldOption[] = []
    for (const item of data?.items ?? []) {
      const id = typeof item.id === 'string' ? item.id : null
      const label = readText(item.title)
      if (id && label) options.push({ value: id, label })
    }
    return options
  } catch {
    return []
  }
}

/**
 * Renders an already-chosen document by title when the dialog re-opens, instead of leaving
 * the control looking empty until it is searched again. An id that no longer resolves falls
 * back to itself rather than to blank, so a stale selection is visible rather than silent.
 */
export async function resolveDocumentLabel(id: string): Promise<string> {
  if (!id) return ''
  try {
    const data = await readApiResultOrThrow<ListResponse<DocumentListItem>>(
      `/api/documents?ids=${encodeURIComponent(id)}&pageSize=1`,
    )
    const first = (data?.items ?? [])[0]
    return readText(first?.title) ?? id
  } catch {
    return id
  }
}
