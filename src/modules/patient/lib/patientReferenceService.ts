import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { StaffTeamMember } from '@open-mercato/core/modules/staff/data/entities'

/**
 * Resolves the scalar references this module stores into display names.
 *
 * Why a service and not an ad-hoc lookup at each call site: the spec requires that
 * references are validated *in the same scope* and only against active records on
 * write, while a reference that has since gone inactive stays *readable* as history.
 * Those are two different queries over the same row, and duplicating them across the
 * commands, the list route and the detail route is how one of the copies eventually
 * forgets the tenant predicate.
 *
 * Two things this service deliberately does not do:
 *
 * - **It grants no access.** It resolves an id the caller already holds into a name.
 *   The spec is explicit that `PatientReferenceService` must not widen what the host's
 *   own API would allow, so the pickers that *discover* candidates call the hosts'
 *   endpoints (`GET /api/customers/people`, `GET /api/staff/team-members`) and inherit
 *   their ACL. Nothing here enumerates people.
 * - **It creates no ORM relation.** `customer_entity_id` and `owner_team_member_id` stay
 *   plain uuids. These are scoped scalar reads — allowed by the spec — not a join, so
 *   deleting a CRM person or a staff member cannot cascade into a patient's history.
 *
 * `CustomerEntity.display_name` is covered by the customers module's own encryption map,
 * so it is read through `findWithDecryption`. `StaffTeamMember.display_name` is not
 * encrypted and needs no decrypt pass — but both go through the same helper so that a
 * future change to either host's map does not silently start returning ciphertext to the
 * UI.
 */

export type PatientReferenceScope = {
  tenantId: string
  organizationId: string
}

export type ResolvedReference = {
  id: string
  displayName: string
  /**
   * `false` when the record still exists in scope but is inactive or soft-deleted.
   *
   * The UI shows the name with an "unavailable" marker so existing history stays
   * readable, and the write path refuses to *select* it again. A reference that is not
   * in scope at all is absent from the result map entirely — it is not "unavailable",
   * it is none of this caller's business.
   */
  isAvailable: boolean
}

export type PatientReferenceService = {
  resolveCrmPeople(ids: string[], scope: PatientReferenceScope): Promise<Map<string, ResolvedReference>>
  resolveTeamMembers(ids: string[], scope: PatientReferenceScope): Promise<Map<string, ResolvedReference>>
  /** Throws 422 unless the id is an active CRM person in scope. */
  requireActiveCrmPerson(id: string, scope: PatientReferenceScope): Promise<ResolvedReference>
  /** Throws 422 unless the id is an active staff team member in scope. */
  requireActiveTeamMember(id: string, scope: PatientReferenceScope): Promise<ResolvedReference>
}

/** Drops blanks and duplicates so one repeated id is one row in the `IN (…)` list. */
function normalizeIds(ids: string[]): string[] {
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) seen.add(id)
  }
  return Array.from(seen)
}

export function createPatientReferenceService({ em }: { em: EntityManager }): PatientReferenceService {
  async function resolveCrmPeople(
    ids: string[],
    scope: PatientReferenceScope,
  ): Promise<Map<string, ResolvedReference>> {
    const wanted = normalizeIds(ids)
    const resolved = new Map<string, ResolvedReference>()
    if (wanted.length === 0) return resolved

    // `kind` is part of the predicate rather than checked afterwards: a company id
    // supplied where a person is expected must read as "not found in scope", not as a
    // company whose name we then render as a patient's guardian.
    //
    // `deletedAt` is intentionally NOT filtered out. A soft-deleted person that a
    // patient was legitimately linked to must still render as history; the row's own
    // flags decide `isAvailable` below.
    const rows = await findWithDecryption(
      em,
      CustomerEntity,
      {
        id: { $in: wanted },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        kind: 'person',
      } as FilterQuery<CustomerEntity>,
      undefined,
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )

    for (const row of rows) {
      resolved.set(String(row.id), {
        id: String(row.id),
        displayName: String(row.displayName ?? ''),
        isAvailable: row.isActive !== false && !row.deletedAt,
      })
    }
    return resolved
  }

  async function resolveTeamMembers(
    ids: string[],
    scope: PatientReferenceScope,
  ): Promise<Map<string, ResolvedReference>> {
    const wanted = normalizeIds(ids)
    const resolved = new Map<string, ResolvedReference>()
    if (wanted.length === 0) return resolved

    const rows = await findWithDecryption(
      em,
      StaffTeamMember,
      {
        id: { $in: wanted },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      } as FilterQuery<StaffTeamMember>,
      undefined,
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )

    for (const row of rows) {
      resolved.set(String(row.id), {
        id: String(row.id),
        displayName: String(row.displayName ?? ''),
        isAvailable: row.isActive !== false && !row.deletedAt,
      })
    }
    return resolved
  }

  /**
   * 422, not 404, for both `require*` helpers.
   *
   * The distinction the spec's error matrix draws: 404 means "the record you addressed
   * is not visible to you", 422 means "your payload named a reference that cannot be
   * used". A guardian id belonging to another organization is the second case — the
   * patient being edited is perfectly visible, the referenced person is not usable. It
   * also avoids the probe where a 404-vs-422 difference would reveal whether an id
   * exists elsewhere in the system.
   */
  async function requireActiveCrmPerson(id: string, scope: PatientReferenceScope): Promise<ResolvedReference> {
    const resolved = (await resolveCrmPeople([id], scope)).get(id)
    if (!resolved || !resolved.isAvailable) {
      throw new CrudHttpError(422, { error: 'Referenced person is not an active CRM person in this scope' })
    }
    return resolved
  }

  async function requireActiveTeamMember(id: string, scope: PatientReferenceScope): Promise<ResolvedReference> {
    const resolved = (await resolveTeamMembers([id], scope)).get(id)
    if (!resolved || !resolved.isAvailable) {
      throw new CrudHttpError(422, { error: 'Referenced team member is not active in this scope' })
    }
    return resolved
  }

  return { resolveCrmPeople, resolveTeamMembers, requireActiveCrmPerson, requireActiveTeamMember }
}
