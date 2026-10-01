import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import {
  CatalogProductCategoryAssignment,
  CatalogProductPrice,
} from '@open-mercato/core/modules/catalog/data/entities'
import { resolvePriceKindCode, type PriceRow } from '@open-mercato/core/modules/catalog/lib/pricing'
import type { CatalogPricingService } from '@open-mercato/core/modules/catalog/services/catalogPricingService'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { PatientVisit } from '../../patient/data/entities'
import type {
  PatientAvailabilityService,
  PlannerAvailabilityService,
} from '../../patient/lib/patientAvailabilityService'
import type { VisitSubjectAvailability } from '../../patient/lib/visitConflicts'
import type { PublicBookingScope } from './commandSupport'

export const PUBLIC_BOOKING_TIME_ZONE = 'Europe/Warsaw'
export const PUBLIC_BOOKING_SLOT_MINUTES = 15
export const PUBLIC_BOOKING_MIN_LEAD_MINUTES = 120
export const PUBLIC_BOOKING_MAX_DAYS = 60

export type PublicBookingPrice = {
  currency: string
  amount: string
  wasAmount?: string
  isPromotion: boolean
}

export type PublicBookingService = {
  id: string
  title: string
  description: string
  durationMinutes: number
  category: string
  price: PublicBookingPrice
}

export type PublicBookingTherapist = {
  id: string
  displayName: string
  photoUrl?: string
  shortBio?: string
  specializations?: string[]
}

export type PublicBookingSlot = {
  startsAt: string
  endsAt: string
  timeZone: string
}

export type PublicBookingAvailabilityResult = {
  slots: PublicBookingSlot[]
  degraded?: true
}

export type ResolvedPublicBookingSlot = {
  resourceId: string
  startsAt: Date
  endsAt: Date
}

type BookableProduct = {
  id: string
  title: string
  description: string
  durationMinutes: number
  teamMemberIds: string[]
  resourceIds: string[]
}

type ProductRow = Record<string, unknown>
type NamedResource = { id: string; name: string; isActive: boolean }

function text(row: ProductRow, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function textList(row: ProductRow, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = row[key]
    if (Array.isArray(value)) {
      return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    }
  }
  return []
}

function number(row: ProductRow, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key]
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return null
}

function toBookableProduct(row: ProductRow): BookableProduct | null {
  const id = text(row, 'id')
  const title = text(row, 'title')
  const durationMinutes = number(row, 'cf:booking_duration_minutes', 'cf_booking_duration_minutes')
  const teamMemberIds = textList(row, 'cf:booking_team_member_ids', 'cf_booking_team_member_ids')
  const resourceIds = textList(row, 'cf:booking_resource_ids', 'cf_booking_resource_ids')
  if (!id || !title || !durationMinutes || teamMemberIds.length === 0 || resourceIds.length === 0) return null
  return {
    id,
    title,
    description: text(row, 'description') ?? '',
    durationMinutes,
    teamMemberIds,
    resourceIds,
  }
}

async function queryBookableProducts(
  queryEngine: QueryEngine,
  scope: PublicBookingScope,
  productId?: string,
): Promise<BookableProduct[]> {
  const result = await queryEngine.query<ProductRow>(E.catalog.catalog_product, {
    fields: [
      'id',
      'title',
      'description',
      'is_active',
      'deleted_at',
      'cf:booking_duration_minutes',
      'cf:booking_team_member_ids',
      'cf:booking_resource_ids',
    ],
    filters: {
      is_active: true,
      deleted_at: null,
      ...(productId ? { id: productId } : {}),
    },
    page: { page: 1, pageSize: productId ? 1 : 100 },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  if (result.total > result.items.length) {
    throw new CrudHttpError(503, { error: 'Public booking catalogue is temporarily unavailable' })
  }
  return result.items.map(toBookableProduct).filter((item): item is BookableProduct => item !== null)
}

function productIdOfPrice(row: PriceRow): string | null {
  if (!row.product) return null
  return typeof row.product === 'string' ? row.product : row.product.id
}

function money(row: PriceRow): string | null {
  return row.unitPriceGross ?? row.unitPriceNet ?? null
}

function isPromotion(row: PriceRow): boolean {
  return resolvePriceKindCode(row) === 'promotion'
    || (typeof row.priceKind !== 'string' && row.priceKind?.isPromotion === true)
}

export async function listPublicBookingServices(input: {
  em: EntityManager
  container: AwilixContainer
  queryEngine: QueryEngine
  scope: PublicBookingScope
  now?: Date
}): Promise<PublicBookingService[]> {
  const products = await queryBookableProducts(input.queryEngine, input.scope)
  if (products.length === 0) return []
  const productIds = products.map((product) => product.id)
  const [assignments, priceRows] = await Promise.all([
    input.em.find(CatalogProductCategoryAssignment, {
      tenantId: input.scope.tenantId,
      organizationId: input.scope.organizationId,
      product: { $in: productIds },
      category: { isActive: true, deletedAt: null },
    }, { populate: ['product', 'category'], orderBy: { position: 'asc', id: 'asc' } }),
    input.em.find(CatalogProductPrice, {
      tenantId: input.scope.tenantId,
      organizationId: input.scope.organizationId,
      product: { $in: productIds },
    } as FilterQuery<CatalogProductPrice>, { populate: ['product', 'variant', 'priceKind', 'offer'] }),
  ])
  const categoryByProduct = new Map<string, string>()
  for (const assignment of assignments) {
    const productId = typeof assignment.product === 'string' ? assignment.product : assignment.product.id
    const category = typeof assignment.category === 'string' ? null : assignment.category
    if (category && !categoryByProduct.has(productId)) categoryByProduct.set(productId, category.name)
  }
  const rowsByProduct = new Map<string, PriceRow[]>()
  for (const row of priceRows as PriceRow[]) {
    const productId = productIdOfPrice(row)
    if (!productId) continue
    const bucket = rowsByProduct.get(productId) ?? []
    bucket.push(row)
    rowsByProduct.set(productId, bucket)
  }
  const pricing = input.container.resolve<CatalogPricingService>('catalogPricingService')
  const now = input.now ?? new Date()
  const contexts = products.map((product) => ({
    rows: rowsByProduct.get(product.id) ?? [],
    context: { quantity: 1, date: now },
  }))
  const resolved = await pricing.resolvePriceMany(contexts)
  const regular = await pricing.resolvePriceMany(contexts.map((entry) => ({
    ...entry,
    rows: entry.rows.filter((row) => !isPromotion(row)),
  })))
  return products.flatMap((product, index) => {
    const best = resolved[index]
    const amount = best ? money(best) : null
    if (!best || !amount) return []
    const promoted = isPromotion(best)
    const baseAmount = promoted && regular[index] ? money(regular[index]!) : null
    return [{
      id: product.id,
      title: product.title,
      description: product.description,
      durationMinutes: product.durationMinutes,
      category: categoryByProduct.get(product.id) ?? '',
      price: {
        currency: best.currencyCode,
        amount,
        ...(promoted && baseAmount && baseAmount !== amount ? { wasAmount: baseAmount } : {}),
        isPromotion: promoted,
      },
    }]
  })
}

export async function listPublicBookingTherapists(input: {
  queryEngine: QueryEngine
  scope: PublicBookingScope
  productId: string
}): Promise<PublicBookingTherapist[]> {
  const [product] = await queryBookableProducts(input.queryEngine, input.scope, input.productId)
  if (!product) throw new CrudHttpError(404, { error: 'Bookable service not found' })
  const result = await input.queryEngine.query<ProductRow>(E.staff.staff_team_member, {
    fields: [
      'id',
      'display_name',
      'is_active',
      'deleted_at',
      'cf:polana_photo_url',
      'cf:polana_short_bio',
      'cf:polana_specializations',
    ],
    filters: { id: { $in: product.teamMemberIds }, is_active: true, deleted_at: null },
    page: { page: 1, pageSize: product.teamMemberIds.length + 1 },
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
  })
  const order = new Map(product.teamMemberIds.map((id, index) => [id, index]))
  return result.items.flatMap((row) => {
    const id = text(row, 'id')
    const displayName = text(row, 'display_name', 'displayName')
    if (!id || !displayName || !order.has(id)) return []
    const specializations = textList(row, 'cf:polana_specializations', 'cf_polana_specializations')
    return [{
      id,
      displayName,
      ...(text(row, 'cf:polana_photo_url', 'cf_polana_photo_url') ? {
        photoUrl: text(row, 'cf:polana_photo_url', 'cf_polana_photo_url')!,
      } : {}),
      ...(text(row, 'cf:polana_short_bio', 'cf_polana_short_bio') ? {
        shortBio: text(row, 'cf:polana_short_bio', 'cf_polana_short_bio')!,
      } : {}),
      ...(specializations.length > 0 ? { specializations } : {}),
    }]
  }).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

function isWindowAvailable(subject: VisitSubjectAvailability, start: Date, end: Date): boolean {
  if (subject.unknown || subject.hasSchedule !== true || subject.isActive === false) return false
  const contained = subject.availableWindows.some((window) => window.start <= start && window.end >= end)
  if (!contained) return false
  return !subject.unavailableWindows.some((window) => window.start < end && window.end > start)
}

function nextGridStart(value: Date): Date {
  const grid = PUBLIC_BOOKING_SLOT_MINUTES * 60_000
  return new Date(Math.ceil(value.getTime() / grid) * grid)
}

async function resolveActiveResources(
  queryEngine: QueryEngine,
  scope: PublicBookingScope,
  resourceIds: string[],
): Promise<NamedResource[]> {
  const result = await queryEngine.query<ProductRow>(E.resources.resources_resource, {
    fields: ['id', 'name', 'is_active', 'deleted_at'],
    filters: { id: { $in: resourceIds }, is_active: true, deleted_at: null },
    page: { page: 1, pageSize: resourceIds.length + 1 },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  const order = new Map(resourceIds.map((id, index) => [id, index]))
  return result.items.flatMap((row) => {
    const id = text(row, 'id')
    const name = text(row, 'name')
    return id && name && order.has(id) ? [{ id, name, isActive: true }] : []
  }).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

export async function findPublicBookingAvailability(input: {
  em: EntityManager
  container: AwilixContainer
  queryEngine: QueryEngine
  scope: PublicBookingScope
  productId: string
  teamMemberId: string
  from: Date
  to: Date
  now?: Date
}): Promise<PublicBookingAvailabilityResult> {
  const now = input.now ?? new Date()
  const maxTo = new Date(now.getTime() + PUBLIC_BOOKING_MAX_DAYS * 24 * 60 * 60_000)
  if (
    !Number.isFinite(input.from.getTime())
    || !Number.isFinite(input.to.getTime())
    || input.from >= input.to
    || input.from < now
    || input.to > maxTo
  ) {
    throw new CrudHttpError(422, { error: 'Availability range must be within the next 60 days' })
  }
  const [product] = await queryBookableProducts(input.queryEngine, input.scope, input.productId)
  if (!product || !product.teamMemberIds.includes(input.teamMemberId)) {
    throw new CrudHttpError(404, { error: 'Bookable service or therapist not found' })
  }
  const [therapists, resources] = await Promise.all([
    listPublicBookingTherapists({
      queryEngine: input.queryEngine,
      scope: input.scope,
      productId: input.productId,
    }),
    resolveActiveResources(input.queryEngine, input.scope, product.resourceIds),
  ])
  const therapist = therapists.find((item) => item.id === input.teamMemberId)
  if (!therapist || resources.length === 0) return { slots: [] }
  const availability = input.container.resolve<PatientAvailabilityService>('patientAvailabilityService')
  let planner: PlannerAvailabilityService | null = null
  try {
    planner = input.container.resolve<PlannerAvailabilityService>('plannerAvailabilityService')
  } catch {
    return { slots: [], degraded: true }
  }
  try {
    const [memberSubjects, resourceSubjects] = await Promise.all([
      availability.getSubjectAvailability({
        scope: input.scope,
        range: { start: input.from, end: input.to },
        teamMember: { id: therapist.id, name: therapist.displayName },
        plannerAvailabilityService: planner,
      }),
      Promise.all(resources.map(async (resource) => (
        await availability.getSubjectAvailability({
          scope: input.scope,
          range: { start: input.from, end: input.to },
          resource,
          plannerAvailabilityService: planner,
        })
      )[0])),
    ])
    const member = memberSubjects[0]
    if (!member || member.unknown || resourceSubjects.some((subject) => subject?.unknown)) {
      return { slots: [], degraded: true }
    }
    const visits = await input.em.find(PatientVisit, {
      tenantId: input.scope.tenantId,
      organizationId: input.scope.organizationId,
      deletedAt: null,
      status: { $ne: 'cancelled' },
      $and: [
        { $or: [{ teamMemberId: input.teamMemberId }, { resourceId: { $in: resources.map((item) => item.id) } }] },
        { startsAt: { $lt: input.to } },
        { $or: [{ endsAt: { $gt: input.from } }, { endsAt: null, startsAt: { $gte: input.from } }] },
      ],
    } as FilterQuery<PatientVisit>, {
      fields: ['teamMemberId', 'resourceId', 'startsAt', 'endsAt'],
      orderBy: { startsAt: 'asc', id: 'asc' },
      limit: 5_001,
    })
    if (visits.length > 5_000) return { slots: [], degraded: true }
    const durationMs = product.durationMinutes * 60_000
    const first = nextGridStart(new Date(Math.max(
      input.from.getTime(),
      now.getTime() + PUBLIC_BOOKING_MIN_LEAD_MINUTES * 60_000,
    )))
    const slots: PublicBookingSlot[] = []
    for (
      let startsAt = first;
      startsAt.getTime() + durationMs <= input.to.getTime();
      startsAt = new Date(startsAt.getTime() + PUBLIC_BOOKING_SLOT_MINUTES * 60_000)
    ) {
      const endsAt = new Date(startsAt.getTime() + durationMs)
      if (!isWindowAvailable(member, startsAt, endsAt)) continue
      const therapistBusy = visits.some((visit) => (
        visit.teamMemberId === input.teamMemberId
        && visit.startsAt < endsAt
        && (!visit.endsAt || visit.endsAt > startsAt)
      ))
      if (therapistBusy) continue
      const freeResource = resources.some((resource, index) => {
        const subject = resourceSubjects[index]
        if (!subject || !isWindowAvailable(subject, startsAt, endsAt)) return false
        return !visits.some((visit) => (
          visit.resourceId === resource.id
          && visit.startsAt < endsAt
          && (!visit.endsAt || visit.endsAt > startsAt)
        ))
      })
      if (freeResource) {
        slots.push({
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          timeZone: PUBLIC_BOOKING_TIME_ZONE,
        })
      }
    }
    return { slots }
  } catch {
    return { slots: [], degraded: true }
  }
}

/**
 * Revalidates one submitted slot and returns the first configured free resource.
 * Unlike the discovery endpoint, infrastructure uncertainty is fail-closed because
 * this result authorizes a write.
 */
export async function resolvePublicBookingSlot(input: {
  em: EntityManager
  container: AwilixContainer
  queryEngine: QueryEngine
  scope: PublicBookingScope
  productId: string
  teamMemberId: string
  startsAt: Date
  endsAt: Date
  timeZone: string
  now?: Date
}): Promise<ResolvedPublicBookingSlot> {
  const now = input.now ?? new Date()
  const maxStart = new Date(now.getTime() + PUBLIC_BOOKING_MAX_DAYS * 24 * 60 * 60_000)
  if (
    input.timeZone !== PUBLIC_BOOKING_TIME_ZONE
    || !Number.isFinite(input.startsAt.getTime())
    || !Number.isFinite(input.endsAt.getTime())
    || input.startsAt >= input.endsAt
    || input.startsAt.getTime() < now.getTime() + PUBLIC_BOOKING_MIN_LEAD_MINUTES * 60_000
    || input.startsAt > maxStart
    || input.startsAt.getUTCMinutes() % PUBLIC_BOOKING_SLOT_MINUTES !== 0
    || input.startsAt.getUTCSeconds() !== 0
    || input.startsAt.getUTCMilliseconds() !== 0
  ) {
    throw new CrudHttpError(422, { error: 'The selected appointment time is outside the booking window' })
  }

  const [product] = await queryBookableProducts(input.queryEngine, input.scope, input.productId)
  if (!product || !product.teamMemberIds.includes(input.teamMemberId)) {
    throw new CrudHttpError(404, { error: 'Bookable service or therapist not found' })
  }
  if (input.endsAt.getTime() - input.startsAt.getTime() !== product.durationMinutes * 60_000) {
    throw new CrudHttpError(422, { error: 'The selected appointment duration is invalid' })
  }

  const [therapists, resources] = await Promise.all([
    listPublicBookingTherapists({
      queryEngine: input.queryEngine,
      scope: input.scope,
      productId: input.productId,
    }),
    resolveActiveResources(input.queryEngine, input.scope, product.resourceIds),
  ])
  const therapist = therapists.find((item) => item.id === input.teamMemberId)
  if (!therapist || resources.length === 0) {
    throw new CrudHttpError(404, { error: 'Bookable service or therapist not found' })
  }

  const availability = input.container.resolve<PatientAvailabilityService>('patientAvailabilityService')
  let planner: PlannerAvailabilityService
  try {
    planner = input.container.resolve<PlannerAvailabilityService>('plannerAvailabilityService')
  } catch {
    throw new CrudHttpError(503, { error: 'Public booking availability is temporarily unavailable' })
  }

  let member: VisitSubjectAvailability | undefined
  let resourceSubjects: Array<VisitSubjectAvailability | undefined>
  try {
    const [memberSubjects, loadedResources] = await Promise.all([
      availability.getSubjectAvailability({
        scope: input.scope,
        range: { start: input.startsAt, end: input.endsAt },
        teamMember: { id: therapist.id, name: therapist.displayName },
        plannerAvailabilityService: planner,
      }),
      Promise.all(resources.map(async (resource) => (
        await availability.getSubjectAvailability({
          scope: input.scope,
          range: { start: input.startsAt, end: input.endsAt },
          resource,
          plannerAvailabilityService: planner,
        })
      )[0])),
    ])
    member = memberSubjects[0]
    resourceSubjects = loadedResources
  } catch {
    throw new CrudHttpError(503, { error: 'Public booking availability is temporarily unavailable' })
  }
  if (!member || member.unknown || resourceSubjects.some((subject) => !subject || subject.unknown)) {
    throw new CrudHttpError(503, { error: 'Public booking availability is temporarily unavailable' })
  }

  const visits = await input.em.find(PatientVisit, {
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    deletedAt: null,
    status: { $ne: 'cancelled' },
    $and: [
      { $or: [{ teamMemberId: input.teamMemberId }, { resourceId: { $in: resources.map((item) => item.id) } }] },
      { startsAt: { $lt: input.endsAt } },
      { $or: [{ endsAt: { $gt: input.startsAt } }, { endsAt: null, startsAt: { $gte: input.startsAt } }] },
    ],
  } as FilterQuery<PatientVisit>, {
    fields: ['teamMemberId', 'resourceId', 'startsAt', 'endsAt'],
    limit: 5_001,
  })
  if (visits.length > 5_000) {
    throw new CrudHttpError(503, { error: 'Public booking availability is temporarily unavailable' })
  }
  if (!isWindowAvailable(member, input.startsAt, input.endsAt)) {
    throw new CrudHttpError(409, { error: 'The selected appointment time is no longer available' })
  }
  const therapistBusy = visits.some((visit) => (
    visit.teamMemberId === input.teamMemberId
    && visit.startsAt < input.endsAt
    && (!visit.endsAt || visit.endsAt > input.startsAt)
  ))
  if (therapistBusy) {
    throw new CrudHttpError(409, { error: 'The selected appointment time is no longer available' })
  }
  const resource = resources.find((candidate, index) => {
    const subject = resourceSubjects[index]
    if (!subject || !isWindowAvailable(subject, input.startsAt, input.endsAt)) return false
    return !visits.some((visit) => (
      visit.resourceId === candidate.id
      && visit.startsAt < input.endsAt
      && (!visit.endsAt || visit.endsAt > input.startsAt)
    ))
  })
  if (!resource) {
    throw new CrudHttpError(409, { error: 'The selected appointment time is no longer available' })
  }
  return { resourceId: resource.id, startsAt: input.startsAt, endsAt: input.endsAt }
}
