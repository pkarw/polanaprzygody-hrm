import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { getSecurityEmailBaseUrl } from '@open-mercato/shared/lib/url'
import { PatientVisit, PatientVisitService } from '../data/entities'
import {
  assertExpectedVersion,
  isLockWaitTimeout,
  requirePatientScope,
  resolvePatientLockWaitTimeoutMs,
  type PatientScope,
} from './commandSupport'
import {
  CHECKOUT_LINK_ENTITY_ID,
  PATIENT_VISIT_ENTITY_ID,
  type VisitPaymentStatus,
} from './visitPaymentFields'

const CHECKOUT_TEMPLATE_ENTITY_ID = 'checkout:checkout_link_template' as const
const CHECKOUT_TRANSACTION_ENTITY_ID = 'checkout:checkout_transaction' as const
const CATALOG_PRICE_ENTITY_ID = 'catalog:catalog_product_price' as const
const MULTI_SERVICE_FIXTURE_KEY = 'visit:multi'
const ACTIVE_LINK_STATUSES = new Set(['active', 'draft'])

export type VisitPaymentLink = {
  id: string
  slug: string
  url: string
  status: VisitPaymentStatus
}

type VisitServiceSnapshot = {
  productId: string
  title: string
}

type LockedVisitSnapshot = {
  id: string
  updatedAt: string
  services: VisitServiceSnapshot[]
  paymentLinkId: string | null
  paymentLinkSlug: string | null
  paymentLinkStatus: VisitPaymentStatus | null
  paymentReceivedAt: string | null
}

type LinkRecord = {
  id: string
  slug: string
  status: string
}

type TemplateRecord = {
  id: string
  name: string
}

type ResolvedServicePrice = {
  productId: string
  title: string
  amount: string | number
  currencyCode: string
}

export type VisitPaymentLinkDependencies = {
  withLockedVisit<T>(
    visitId: string,
    scope: PatientScope,
    work: (visit: LockedVisitSnapshot) => Promise<T>,
  ): Promise<T>
  findLinkById(id: string, scope: PatientScope): Promise<LinkRecord | null>
  findActiveLinksForVisit(visitId: string, scope: PatientScope): Promise<LinkRecord[]>
  hasCompletedPayment(linkId: string, scope: PatientScope): Promise<boolean>
  findTemplateForProduct(productId: string, scope: PatientScope): Promise<TemplateRecord[]>
  findMultiServiceTemplate(scope: PatientScope): Promise<TemplateRecord[]>
  resolveServicePrices(services: VisitServiceSnapshot[], scope: PatientScope): Promise<ResolvedServicePrice[]>
  createLink(input: Record<string, unknown>, ctx: CommandRuntimeContext): Promise<{ id: string; slug: string }>
  deactivateLink(id: string, ctx: CommandRuntimeContext): Promise<void>
  setVisitPaymentFields(
    visitId: string,
    values: Record<string, string | null>,
    scope: PatientScope,
  ): Promise<void>
  resolveTrustedOrigin(): string
}

export class VisitPaymentLinkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'VisitPaymentLinkError'
  }
}

export type VisitPaymentLinkService = {
  ensureForVisit(
    visitId: string,
    ctx: CommandRuntimeContext,
    expectedUpdatedAt?: string,
  ): Promise<VisitPaymentLink>
  deactivateForVisit(visitId: string, ctx: CommandRuntimeContext): Promise<VisitPaymentLink | null>
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function paymentStatus(value: string | null): VisitPaymentStatus | null {
  if (!value) return null
  if (['pending', 'processing', 'completed', 'failed', 'cancelled', 'expired', 'inactive'].includes(value)) {
    return value as VisitPaymentStatus
  }
  return null
}

function toMinorUnits(value: string | number): bigint {
  const normalized = typeof value === 'number' ? value.toString() : value.trim()
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized)
  if (!match) throw new VisitPaymentLinkError('payment_price_invalid', 'A service has an invalid price')
  const fraction = match[2] ?? ''
  if (fraction.slice(2).replace(/0/g, '').length > 0) {
    throw new VisitPaymentLinkError('payment_price_precision_unsupported', 'A PLN price has more than two decimal places')
  }
  return BigInt(match[1]) * 100n + BigInt((fraction.slice(0, 2) + '00').slice(0, 2))
}

function fromMinorUnits(value: bigint): string {
  const whole = value / 100n
  const fraction = (value % 100n).toString().padStart(2, '0')
  return `${whole}.${fraction}`
}

function paymentUrl(origin: string, slug: string): string {
  const parsed = new URL(origin)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new VisitPaymentLinkError('payment_origin_invalid', 'The configured application origin is invalid')
  }
  const base = parsed.toString().replace(/\/$/, '')
  return `${base}/pay/${encodeURIComponent(slug)}`
}

function linkResult(
  link: Pick<LinkRecord, 'id' | 'slug'>,
  status: VisitPaymentStatus,
  resolveTrustedOrigin: () => string,
): VisitPaymentLink {
  return {
    id: link.id,
    slug: link.slug,
    url: paymentUrl(resolveTrustedOrigin(), link.slug),
    status,
  }
}

function requireOneTemplate(templates: TemplateRecord[], code: string): TemplateRecord {
  if (templates.length === 0) {
    throw new VisitPaymentLinkError(`${code}_missing`, 'A scoped payment-link template is missing')
  }
  if (templates.length > 1) {
    throw new VisitPaymentLinkError(`${code}_ambiguous`, 'More than one scoped payment-link template matches')
  }
  return templates[0]!
}

export function createVisitPaymentLinkServiceCore(
  dependencies: VisitPaymentLinkDependencies,
): {
  ensureForVisit(
    visitId: string,
    scope: PatientScope,
    ctx: CommandRuntimeContext,
    expectedUpdatedAt?: string,
  ): Promise<VisitPaymentLink>
  deactivateForVisit(
    visitId: string,
    scope: PatientScope,
    ctx: CommandRuntimeContext,
  ): Promise<VisitPaymentLink | null>
} {
  return {
    async ensureForVisit(visitId, scope, ctx, expectedUpdatedAt) {
      if (!visitId || !scope.tenantId || !scope.organizationId) {
        throw new VisitPaymentLinkError('payment_scope_required', 'Visit payment links require tenant and organization scope')
      }

      return dependencies.withLockedVisit(visitId, scope, async (visit) => {
        if (expectedUpdatedAt) {
          assertExpectedVersion(expectedUpdatedAt, new Date(visit.updatedAt), PATIENT_VISIT_ENTITY_ID)
        }
        if (visit.paymentLinkStatus === 'completed' || visit.paymentReceivedAt) {
          if (!visit.paymentLinkId) {
            throw new VisitPaymentLinkError(
              'payment_completed_pointer_missing',
              'A completed payment cannot be replaced without its checkout-link reference',
            )
          }
          const completedLink = await dependencies.findLinkById(visit.paymentLinkId, scope)
          if (!completedLink) {
            throw new VisitPaymentLinkError(
              'payment_completed_pointer_missing',
              'A completed payment cannot be replaced without its scoped checkout link',
            )
          }
          return linkResult(completedLink, 'completed', dependencies.resolveTrustedOrigin)
        }

        if (visit.paymentLinkId) {
          const pointed = await dependencies.findLinkById(visit.paymentLinkId, scope)
          if (pointed && ACTIVE_LINK_STATUSES.has(pointed.status)) {
            const status = visit.paymentLinkStatus ?? 'pending'
            if (visit.paymentLinkSlug !== pointed.slug) {
              await dependencies.setVisitPaymentFields(visit.id, {
                payment_link_id: pointed.id,
                payment_link_slug: pointed.slug,
                payment_link_status: status,
              }, scope)
            }
            return linkResult(pointed, status, dependencies.resolveTrustedOrigin)
          }
        }

        const orphanCandidates = await dependencies.findActiveLinksForVisit(visit.id, scope)
        if (orphanCandidates.length > 1) {
          throw new VisitPaymentLinkError(
            'payment_link_orphan_ambiguous',
            'Multiple active checkout links reference this visit',
          )
        }
        if (orphanCandidates.length === 1) {
          const adopted = orphanCandidates[0]!
          await dependencies.setVisitPaymentFields(visit.id, {
            payment_link_id: adopted.id,
            payment_link_slug: adopted.slug,
            payment_link_status: 'pending',
          }, scope)
          return linkResult(adopted, 'pending', dependencies.resolveTrustedOrigin)
        }

        if (visit.services.length === 0) {
          throw new VisitPaymentLinkError('no_services_on_visit', 'The visit has no services to charge for')
        }

        const prices = await dependencies.resolveServicePrices(visit.services, scope)
        if (prices.length !== visit.services.length) {
          throw new VisitPaymentLinkError('payment_price_missing', 'A current price is missing for one or more services')
        }
        const currencies = new Set(prices.map((price) => price.currencyCode.trim().toUpperCase()))
        if (currencies.size !== 1 || !currencies.has('PLN')) {
          throw new VisitPaymentLinkError('payment_currency_mismatch', 'Visit services must all have a current PLN price')
        }
        const totalMinor = prices.reduce((sum, price) => sum + toMinorUnits(price.amount), 0n)
        if (totalMinor <= 0n) {
          throw new VisitPaymentLinkError('payment_price_invalid', 'The visit total must be greater than zero')
        }

        const template = visit.services.length === 1
          ? requireOneTemplate(
              await dependencies.findTemplateForProduct(visit.services[0]!.productId, scope),
              'payment_service_template',
            )
          : requireOneTemplate(await dependencies.findMultiServiceTemplate(scope), 'payment_multi_template')

        const created = await dependencies.createLink({
          templateId: template.id,
          name: `Płatność za wizytę ${visit.id}`,
          pricingMode: 'fixed',
          fixedPriceAmount: fromMinorUnits(totalMinor),
          fixedPriceCurrencyCode: 'PLN',
          fixedPriceIncludesTax: true,
          gatewayProviderKey: 'stripe',
          maxCompletions: 1,
          status: 'active',
          checkoutType: 'pay_link',
          customFields: { patient_visit_id: visit.id },
          // Conventional flattened alias for command-interceptor/audit visibility.
          // The installed checkout command persists the `customFields` object above.
          cf_patient_visit_id: visit.id,
        }, ctx)

        await dependencies.setVisitPaymentFields(visit.id, {
          payment_link_id: created.id,
          payment_link_slug: created.slug,
          payment_link_status: 'pending',
        }, scope)
        return linkResult(created, 'pending', dependencies.resolveTrustedOrigin)
      })
    },
    async deactivateForVisit(visitId, scope, ctx) {
      if (!visitId || !scope.tenantId || !scope.organizationId) {
        throw new VisitPaymentLinkError('payment_scope_required', 'Visit payment links require tenant and organization scope')
      }

      return dependencies.withLockedVisit(visitId, scope, async (visit) => {
        if (visit.paymentLinkStatus === 'completed' || visit.paymentReceivedAt) {
          throw new VisitPaymentLinkError('visit_already_paid', 'A paid visit cannot be unconfirmed')
        }
        if (!visit.paymentLinkId) return null
        if (await dependencies.hasCompletedPayment(visit.paymentLinkId, scope)) {
          throw new VisitPaymentLinkError('visit_already_paid', 'A paid visit cannot be unconfirmed')
        }

        const link = await dependencies.findLinkById(visit.paymentLinkId, scope)
        if (link && link.status !== 'inactive') {
          await dependencies.deactivateLink(link.id, ctx)
        }
        await dependencies.setVisitPaymentFields(visit.id, {
          payment_link_status: 'inactive',
        }, scope)
        if (!link) return null
        return linkResult(link, 'inactive', dependencies.resolveTrustedOrigin)
      })
    },
  }
}

type CatalogPricingServiceLike = {
  resolvePrice(rows: Array<Record<string, unknown>>, context: Record<string, unknown>): Promise<Record<string, unknown> | null>
}

function normalizeLinkRecord(row: Record<string, unknown>): LinkRecord | null {
  const id = readString(row, 'id')
  const slug = readString(row, 'slug')
  const status = readString(row, 'status')
  return id && slug && status ? { id, slug, status } : null
}

function normalizeTemplateRecord(row: Record<string, unknown>): TemplateRecord | null {
  const id = readString(row, 'id')
  const name = readString(row, 'name')
  return id && name ? { id, name } : null
}

function priceRowForResolver(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    product: readString(row, 'product_id', 'productId', 'product'),
    variant: readString(row, 'variant_id', 'variantId', 'variant'),
    offer: readString(row, 'offer_id', 'offerId', 'offer'),
    priceKind: readString(row, 'price_kind_id', 'priceKindId', 'price_kind', 'priceKind'),
    currencyCode: readString(row, 'currency_code', 'currencyCode'),
    kind: readString(row, 'kind') ?? 'regular',
    minQuantity: Number(row.min_quantity ?? row.minQuantity ?? 1),
    maxQuantity: row.max_quantity ?? row.maxQuantity ?? null,
    unitPriceNet: row.unit_price_net ?? row.unitPriceNet ?? null,
    unitPriceGross: row.unit_price_gross ?? row.unitPriceGross ?? null,
    taxRate: row.tax_rate ?? row.taxRate ?? null,
    taxAmount: row.tax_amount ?? row.taxAmount ?? null,
    channelId: readString(row, 'channel_id', 'channelId'),
    userId: readString(row, 'user_id', 'userId'),
    userGroupId: readString(row, 'user_group_id', 'userGroupId'),
    customerId: readString(row, 'customer_id', 'customerId'),
    customerGroupId: readString(row, 'customer_group_id', 'customerGroupId'),
    startsAt: row.starts_at ?? row.startsAt ?? null,
    endsAt: row.ends_at ?? row.endsAt ?? null,
  }
}

export function createProductionDependencies(
  em: EntityManager,
  queryEngine: QueryEngine,
  commandBus: CommandBus,
  dataEngine: DataEngine,
  catalogPricingService: CatalogPricingServiceLike,
): VisitPaymentLinkDependencies {
  const scopedQuery = async (
    entityId: string,
    fields: string[],
    filters: Record<string, unknown>,
    scope: PatientScope,
    pageSize = 2,
  ) => {
    return await queryEngine.query<Record<string, unknown>>(entityId, {
      fields,
      filters,
      page: { page: 1, pageSize },
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })
  }

  return {
    async withLockedVisit(visitId, scope, work) {
      return em.transactional(async (tx) => {
        const lockTimeoutMs = resolvePatientLockWaitTimeoutMs()
        if (lockTimeoutMs > 0) {
          await tx.execute('select set_config(?, ?, true)', ['lock_timeout', `${lockTimeoutMs}ms`])
        }
        let visit: PatientVisit | null
        try {
          visit = await tx.findOne(PatientVisit, {
            id: visitId,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            deletedAt: null,
          } as FilterQuery<PatientVisit>, { lockMode: LockMode.PESSIMISTIC_WRITE })
        } catch (error) {
          if (isLockWaitTimeout(error)) {
            throw new CrudHttpError(409, {
              error: 'This visit is being changed right now; try again in a moment',
              code: 'visit_locked',
            })
          }
          throw error
        }
        if (!visit) throw new CrudHttpError(404, { error: 'Visit not found' })

        const services = await tx.find(PatientVisitService, {
          visitId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          deletedAt: null,
        } as FilterQuery<PatientVisitService>, { orderBy: { position: 'asc' } })
        const custom = await loadCustomFieldValues({
          em: tx,
          entityId: PATIENT_VISIT_ENTITY_ID,
          recordIds: [visitId],
          tenantIdByRecord: { [visitId]: scope.tenantId },
          organizationIdByRecord: { [visitId]: scope.organizationId },
        })
        const values = (custom[visitId] ?? {}) as Record<string, unknown>
        return work({
          id: visit.id,
          updatedAt: visit.updatedAt.toISOString(),
          services: services.map((service) => ({
            productId: service.productId,
            title: service.productTitleSnapshot,
          })),
          paymentLinkId: readString(values, 'cf_payment_link_id', 'cf:payment_link_id', 'payment_link_id'),
          paymentLinkSlug: readString(values, 'cf_payment_link_slug', 'cf:payment_link_slug', 'payment_link_slug'),
          paymentLinkStatus: paymentStatus(readString(values, 'cf_payment_link_status', 'cf:payment_link_status', 'payment_link_status')),
          paymentReceivedAt: readString(values, 'cf_payment_received_at', 'cf:payment_received_at', 'payment_received_at'),
        })
      })
    },
    async findLinkById(id, scope) {
      const result = await scopedQuery(CHECKOUT_LINK_ENTITY_ID, ['id', 'slug', 'status'], { id: { $eq: id } }, scope, 1)
      return result.items.length === 1 ? normalizeLinkRecord(result.items[0]!) : null
    },
    async findActiveLinksForVisit(visitId, scope) {
      const result = await scopedQuery(
        CHECKOUT_LINK_ENTITY_ID,
        ['id', 'slug', 'status'],
        {
          'cf:patient_visit_id': { $eq: visitId },
          status: { $in: ['active', 'draft'] },
        },
        scope,
        2,
      )
      return result.items.flatMap((row) => normalizeLinkRecord(row) ?? [])
    },
    async hasCompletedPayment(linkId, scope) {
      const result = await scopedQuery(
        CHECKOUT_TRANSACTION_ENTITY_ID,
        ['id', 'linkId', 'status'],
        { linkId: { $eq: linkId }, status: { $eq: 'completed' } },
        scope,
        1,
      )
      return result.total > 0
    },
    async findTemplateForProduct(productId, scope) {
      const result = await scopedQuery(
        CHECKOUT_TEMPLATE_ENTITY_ID,
        ['id', 'name'],
        { 'cf:catalog_product_id': { $eq: productId }, status: { $eq: 'active' } },
        scope,
        2,
      )
      return result.items.flatMap((row) => normalizeTemplateRecord(row) ?? [])
    },
    async findMultiServiceTemplate(scope) {
      const result = await scopedQuery(
        CHECKOUT_TEMPLATE_ENTITY_ID,
        ['id', 'name'],
        {
          'cf:polana_payment_fixture_key': { $eq: MULTI_SERVICE_FIXTURE_KEY },
          status: { $eq: 'active' },
        },
        scope,
        2,
      )
      return result.items.flatMap((row) => normalizeTemplateRecord(row) ?? [])
    },
    async resolveServicePrices(services, scope) {
      const resolved: ResolvedServicePrice[] = []
      for (const service of services) {
        const result = await scopedQuery(
          CATALOG_PRICE_ENTITY_ID,
          [
            'id', 'product', 'variant', 'offer', 'price_kind', 'currency_code', 'kind',
            'min_quantity', 'max_quantity', 'unit_price_net', 'unit_price_gross', 'tax_rate', 'tax_amount',
            'channel_id', 'user_id', 'user_group_id', 'customer_id', 'customer_group_id', 'starts_at', 'ends_at',
          ],
          { product: { $eq: service.productId } },
          scope,
          100,
        )
        if (result.total > result.items.length) {
          throw new VisitPaymentLinkError(
            'payment_price_query_truncated',
            'The scoped price set is too large to resolve safely',
          )
        }
        const best = await catalogPricingService.resolvePrice(
          result.items.map(priceRowForResolver),
          { quantity: 1, date: new Date(), currencyCode: 'PLN' },
        )
        const amount = best?.unitPriceGross ?? best?.unit_price_gross ?? best?.unitPriceNet ?? best?.unit_price_net
        const currencyCode = readString(best ?? {}, 'currencyCode', 'currency_code')
        if (amount === null || amount === undefined || !currencyCode) continue
        if (typeof amount !== 'string' && typeof amount !== 'number') continue
        resolved.push({ productId: service.productId, title: service.title, amount, currencyCode })
      }
      return resolved
    },
    async createLink(input, ctx) {
      const { result } = await commandBus.execute<Record<string, unknown>, { id: string; slug: string }>(
        'checkout.link.create',
        { input, ctx },
      )
      return result
    },
    async deactivateLink(id, ctx) {
      await commandBus.execute<Record<string, unknown>, { ok: true; slug: string }>(
        'checkout.link.update',
        {
          input: { id, status: 'inactive' },
          // The caller's optimistic token belongs to the patient visit, not the
          // installed checkout record. The visit lock above is the serialization
          // boundary for this composed action.
          ctx: { ...ctx, request: undefined },
        },
      )
    },
    setVisitPaymentFields: (visitId, values, scope) => dataEngine.setCustomFields({
      entityId: PATIENT_VISIT_ENTITY_ID,
      recordId: visitId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      values,
      notify: true,
    }),
    resolveTrustedOrigin: () => getSecurityEmailBaseUrl(undefined),
  }
}

export function createVisitPaymentLinkService(
  em: EntityManager,
  queryEngine: QueryEngine,
  commandBus: CommandBus,
  dataEngine: DataEngine,
  catalogPricingService: CatalogPricingServiceLike,
): VisitPaymentLinkService {
  const core = createVisitPaymentLinkServiceCore(
    createProductionDependencies(em, queryEngine, commandBus, dataEngine, catalogPricingService),
  )
  return {
    ensureForVisit(visitId, ctx, expectedUpdatedAt) {
      return core.ensureForVisit(visitId, requirePatientScope(ctx), ctx, expectedUpdatedAt)
    },
    deactivateForVisit(visitId, ctx) {
      return core.deactivateForVisit(visitId, requirePatientScope(ctx), ctx)
    },
  }
}
