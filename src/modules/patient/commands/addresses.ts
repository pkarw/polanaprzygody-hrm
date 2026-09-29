import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { CrudEmitContext, CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { PatientAddress } from '../data/entities'
import {
  patientAddressCreateSchema,
  patientAddressDeleteSchema,
  patientAddressUpdateSchema,
} from '../data/validators'
import {
  assertExpectedVersion,
  assertPatientAcceptsNewEntries,
  encryptSensitiveFields,
  lockPatient,
  nextUpdatedAt,
  requireActorUserId,
  requirePatientScope,
  toIsoTimestamp,
  tryResolveEncryptionService,
  type PatientScope,
} from '../lib/commandSupport'

const ADDRESS_ENTITY_ID = 'patient:patient_address' as const

export const patientAddressCrudEvents: CrudEventsConfig<PatientAddress> = {
  module: 'patient',
  entity: 'address',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext<PatientAddress>) => ({
    id: ctx.identifiers.id,
    patientId: ctx.entity?.patientId ?? null,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
    updatedAt: toIsoTimestamp(ctx.entity?.updatedAt),
  }),
}

export const patientAddressCrudIndexer: CrudIndexerConfig<PatientAddress> = {
  entityType: ADDRESS_ENTITY_ID,
}

/** The address columns that carry identifying data and must be encrypted. */
type AddressSensitiveColumns = {
  name?: string | null
  companyName?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  buildingNumber?: string | null
  flatNumber?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
  latitude?: string | null
  longitude?: string | null
}

/**
 * Collects only the sensitive keys the caller actually supplied.
 *
 * `undefined` must not become `null` here: on an update, an absent key means "leave this
 * column alone" while `null` means "clear it", and flattening the two would wipe fields
 * the user never touched.
 */
function collectAddressSensitive(input: {
  name?: string | null
  companyName?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  buildingNumber?: string | null
  flatNumber?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
  latitude?: number | null
  longitude?: number | null
}): AddressSensitiveColumns {
  const columns: AddressSensitiveColumns = {}
  if (input.name !== undefined) columns.name = input.name
  if (input.companyName !== undefined) columns.companyName = input.companyName
  if (input.addressLine1 !== undefined) columns.addressLine1 = input.addressLine1
  if (input.addressLine2 !== undefined) columns.addressLine2 = input.addressLine2
  if (input.buildingNumber !== undefined) columns.buildingNumber = input.buildingNumber
  if (input.flatNumber !== undefined) columns.flatNumber = input.flatNumber
  if (input.city !== undefined) columns.city = input.city
  if (input.region !== undefined) columns.region = input.region
  if (input.postalCode !== undefined) columns.postalCode = input.postalCode
  if (input.country !== undefined) columns.country = input.country
  // Stored as text because the column is encrypted; the read adapter decodes to a number.
  if (input.latitude !== undefined) columns.latitude = input.latitude == null ? null : String(input.latitude)
  if (input.longitude !== undefined) columns.longitude = input.longitude == null ? null : String(input.longitude)
  return columns
}

async function loadAddressDecrypted(
  em: EntityManager,
  id: string,
  scope: PatientScope,
): Promise<PatientAddress> {
  const address = await findOneWithDecryption(
    em,
    PatientAddress,
    {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientAddress>,
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (!address) throw new CrudHttpError(404, { error: 'Address not found' })
  return address
}

/**
 * Demotes whichever address is currently primary for this patient.
 *
 * Must run inside the same transaction as the promotion, and only after the patient row
 * is locked. The partial unique index (`where is_primary and deleted_at is null`) is the
 * backstop that makes two primaries impossible, but on its own it would turn a concurrent
 * promotion into a constraint violation the user cannot interpret; the lock turns it into
 * an ordinary serialized write.
 */
async function demoteCurrentPrimary(
  em: EntityManager,
  patientId: string,
  scope: PatientScope,
  exceptId: string | null,
  updatedAt: Date,
  actorUserId: string,
): Promise<void> {
  const where: Record<string, unknown> = {
    patientId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    isPrimary: true,
    deletedAt: null,
  }
  if (exceptId) where.id = { $ne: exceptId }
  await em.nativeUpdate(PatientAddress, where as FilterQuery<PatientAddress>, {
    isPrimary: false,
    updatedAt,
    updatedByUserId: actorUserId,
  })
}

const createAddressCommand: CommandHandler<Record<string, unknown>, PatientAddress> = {
  id: 'patient.addresses.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientAddressCreateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const patient = await lockPatient(em, parsed.patientId, scope)
    assertPatientAcceptsNewEntries(patient)

    const activeCount = await em.count(PatientAddress, {
      patientId: parsed.patientId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientAddress>)

    // A record with no address must not stay that way: the first address added back is
    // promoted automatically, because "exactly one primary" is an invariant of an active
    // record rather than a user preference.
    const shouldBePrimary = parsed.isPrimary === true || activeCount === 0

    // Built explicitly rather than through `collectAddressSensitive`, because on create
    // `addressLine1` is required by the schema and the entity, while the shared collector
    // has to leave every key optional to express "absent means unchanged" on update.
    const encrypted = await encryptSensitiveFields(
      ADDRESS_ENTITY_ID,
      {
        name: parsed.name ?? null,
        companyName: parsed.companyName ?? null,
        addressLine1: parsed.addressLine1,
        addressLine2: parsed.addressLine2 ?? null,
        buildingNumber: parsed.buildingNumber ?? null,
        flatNumber: parsed.flatNumber ?? null,
        city: parsed.city ?? null,
        region: parsed.region ?? null,
        postalCode: parsed.postalCode ?? null,
        country: parsed.country ?? null,
        latitude: parsed.latitude == null ? null : String(parsed.latitude),
        longitude: parsed.longitude == null ? null : String(parsed.longitude),
      },
      scope,
      tryResolveEncryptionService(ctx),
    )

    const now = nextUpdatedAt(patient.updatedAt)
    let address!: PatientAddress

    await runCrudCommandWrite<PatientAddress>({
      ctx,
      em,
      entityId: ADDRESS_ENTITY_ID,
      action: 'created',
      scope,
      events: patientAddressCrudEvents,
      indexer: patientAddressCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: phaseEm }) => {
          if (shouldBePrimary) {
            await demoteCurrentPrimary(phaseEm, parsed.patientId, scope, null, now, actorUserId)
          }
        },
        ({ em: phaseEm }) => {
          address = phaseEm.create(PatientAddress, {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            patientId: parsed.patientId,
            purpose: parsed.purpose ?? null,
            ...encrypted,
            isPrimary: shouldBePrimary,
            createdAt: now,
            updatedAt: now,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
            deletedAt: null,
          })
          phaseEm.persist(address)
        },
        // Bumping the parent's version is what makes the aggregate's optimistic lock
        // meaningful: a form that loaded the patient before this address existed now
        // holds a stale token and is told so, instead of overwriting the card blind.
        ({ em: phaseEm }) => {
          patient.updatedAt = now
          patient.updatedByUserId = actorUserId
          phaseEm.persist(patient)
        },
      ],
      sideEffect: () => ({
        entity: address,
        identifiers: {
          id: String(address.id),
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
      }),
    })

    return await loadAddressDecrypted(em, String(address.id), scope)
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.addresses.create', 'Add patient address'),
      resourceKind: 'patient.patient_address',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

const updateAddressCommand: CommandHandler<Record<string, unknown>, PatientAddress> = {
  id: 'patient.addresses.update',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientAddressUpdateSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    // Read the address first only to learn its parent, then lock the parent, then
    // re-read under that lock. Locking the patient before touching any of its children
    // keeps the order patient → child everywhere, so two commands approaching from
    // different children cannot deadlock.
    const preliminary = await em.findOne(PatientAddress, {
      id: parsed.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientAddress>)
    if (!preliminary) throw new CrudHttpError(404, { error: 'Address not found' })

    const patient = await lockPatient(em, String(preliminary.patientId), scope)
    const address = await loadAddressDecrypted(em, parsed.id, scope)
    assertExpectedVersion(parsed.expectedUpdatedAt, address.updatedAt, ADDRESS_ENTITY_ID)

    const encrypted = await encryptSensitiveFields(
      ADDRESS_ENTITY_ID,
      collectAddressSensitive(parsed),
      scope,
      tryResolveEncryptionService(ctx),
    )

    const promoting = parsed.isPrimary === true && !address.isPrimary
    const now = nextUpdatedAt(
      patient.updatedAt > address.updatedAt ? patient.updatedAt : address.updatedAt,
    )

    await runCrudCommandWrite<PatientAddress>({
      ctx,
      em,
      entityId: ADDRESS_ENTITY_ID,
      action: 'updated',
      scope,
      events: patientAddressCrudEvents,
      indexer: patientAddressCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        async ({ em: phaseEm }) => {
          if (promoting) {
            await demoteCurrentPrimary(phaseEm, String(address.patientId), scope, parsed.id, now, actorUserId)
          }
        },
        ({ em: phaseEm }) => {
          for (const [key, value] of Object.entries(encrypted)) {
            ;(address as unknown as Record<string, unknown>)[key] = value
          }
          if (parsed.purpose !== undefined) address.purpose = parsed.purpose ?? null
          if (promoting) address.isPrimary = true
          address.updatedAt = now
          address.updatedByUserId = actorUserId
          phaseEm.persist(address)
        },
        ({ em: phaseEm }) => {
          patient.updatedAt = now
          patient.updatedByUserId = actorUserId
          phaseEm.persist(patient)
        },
      ],
      sideEffect: () => ({
        entity: address,
        identifiers: {
          id: parsed.id,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
      }),
    })

    return await loadAddressDecrypted(em, parsed.id, scope)
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.addresses.update', 'Update patient address'),
      resourceKind: 'patient.patient_address',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

/**
 * Soft-deletes an address.
 *
 * Two refusals, both 409, both derived from "an active record has exactly one primary
 * address":
 *
 * 1. **The last active address of an active record.** Stated directly by the spec.
 * 2. **The primary address while others remain.** Allowing it would leave the record with
 *    addresses but no primary. The alternative — silently promoting whichever address
 *    happens to sort first — would pick the patient's billing address as their home
 *    address without telling anyone. The refusal names the remedy: promote another
 *    address first, then delete this one.
 *
 * An archived record is exempt from the first rule: it accepts no new entries, so
 * requiring it to keep a deliverable address serves nothing.
 */
const deleteAddressCommand: CommandHandler<Record<string, unknown>, PatientAddress> = {
  id: 'patient.addresses.delete',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = patientAddressDeleteSchema.parse(rawInput)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const preliminary = await em.findOne(PatientAddress, {
      id: parsed.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientAddress>)
    if (!preliminary) throw new CrudHttpError(404, { error: 'Address not found' })

    const patient = await lockPatient(em, String(preliminary.patientId), scope)
    const address = await em.findOne(PatientAddress, {
      id: parsed.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<PatientAddress>)
    if (!address) throw new CrudHttpError(404, { error: 'Address not found' })
    assertExpectedVersion(parsed.expectedUpdatedAt, address.updatedAt, ADDRESS_ENTITY_ID)

    const remaining = await em.count(PatientAddress, {
      patientId: address.patientId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
      id: { $ne: parsed.id },
    } as FilterQuery<PatientAddress>)

    if (remaining === 0 && patient.status === 'active') {
      throw new CrudHttpError(409, {
        error: 'An active patient must keep at least one address',
        code: 'last_address',
      })
    }
    if (address.isPrimary && remaining > 0) {
      throw new CrudHttpError(409, {
        error: 'Promote another address to primary before deleting this one',
        code: 'primary_address_in_use',
      })
    }

    const deletedAt = nextUpdatedAt(
      patient.updatedAt > address.updatedAt ? patient.updatedAt : address.updatedAt,
    )

    await runCrudCommandWrite<PatientAddress>({
      ctx,
      em,
      entityId: ADDRESS_ENTITY_ID,
      action: 'deleted',
      scope,
      events: patientAddressCrudEvents,
      indexer: patientAddressCrudIndexer,
      syncOrigin: ctx.syncOrigin,
      phases: [
        ({ em: phaseEm }) => {
          address.deletedAt = deletedAt
          address.isPrimary = false
          address.updatedAt = deletedAt
          address.updatedByUserId = actorUserId
          phaseEm.persist(address)
        },
        ({ em: phaseEm }) => {
          patient.updatedAt = deletedAt
          patient.updatedByUserId = actorUserId
          phaseEm.persist(patient)
        },
      ],
      sideEffect: () => ({
        entity: address,
        identifiers: {
          id: parsed.id,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
      }),
    })

    return address
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('patient.audit.addresses.delete', 'Delete patient address'),
      resourceKind: 'patient.patient_address',
      resourceId: String(result.id),
      tenantId: String(result.tenantId),
      organizationId: String(result.organizationId),
    }
  },
}

registerCommand(createAddressCommand)
registerCommand(updateAddressCommand)
registerCommand(deleteAddressCommand)
