import type { EntityManager } from '@mikro-orm/postgresql'
import { ensureCustomFieldDefinitions } from '@open-mercato/core/modules/entities/lib/field-definitions'
import type { CustomFieldDefinition } from '@open-mercato/shared/modules/entities'

export const PATIENT_VISIT_ENTITY_ID = 'patient:patient_visit' as const
export const CHECKOUT_LINK_ENTITY_ID = 'checkout:checkout_link' as const

export const VISIT_PAYMENT_STATUS_VALUES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'inactive',
] as const

export type VisitPaymentStatus = (typeof VISIT_PAYMENT_STATUS_VALUES)[number]

export const PATIENT_VISIT_PAYMENT_FIELDS = [
  {
    key: 'payment_link_id',
    kind: 'text',
    label: 'Identyfikator linku płatności',
    formEditable: false,
    indexed: true,
    filterable: true,
  },
  {
    key: 'payment_link_slug',
    kind: 'text',
    label: 'Slug linku płatności',
    formEditable: false,
  },
  {
    key: 'payment_link_status',
    kind: 'select',
    label: 'Status płatności',
    options: VISIT_PAYMENT_STATUS_VALUES.map((value) => ({ value, label: value })),
    formEditable: false,
    indexed: true,
    filterable: true,
  },
  {
    key: 'payment_received_at',
    kind: 'datetime',
    label: 'Data otrzymania płatności',
    formEditable: false,
    indexed: true,
    filterable: true,
  },
] satisfies CustomFieldDefinition[]

export const CHECKOUT_LINK_VISIT_FIELDS = [
  {
    key: 'patient_visit_id',
    kind: 'text',
    label: 'Identyfikator wizyty pacjenta',
    formEditable: false,
    indexed: true,
    filterable: true,
  },
] satisfies CustomFieldDefinition[]

export type VisitPaymentFieldScope = {
  tenantId: string
  organizationId: string
}

export type VisitPaymentFieldDependencies = {
  ensure(
    sets: Array<{ entity: string; fields: CustomFieldDefinition[]; source: string }>,
    scope: VisitPaymentFieldScope,
  ): Promise<void>
}

export async function ensureVisitPaymentFieldDefinitions(
  dependencies: VisitPaymentFieldDependencies,
  scope: VisitPaymentFieldScope,
): Promise<void> {
  if (!scope.tenantId || !scope.organizationId) {
    throw new Error('Visit payment fields require tenant and organization scope')
  }
  await dependencies.ensure([
    {
      entity: PATIENT_VISIT_ENTITY_ID,
      fields: PATIENT_VISIT_PAYMENT_FIELDS,
      source: 'patient',
    },
    {
      entity: CHECKOUT_LINK_ENTITY_ID,
      fields: CHECKOUT_LINK_VISIT_FIELDS,
      source: 'patient',
    },
  ], scope)
}

export async function ensureVisitPaymentFields(
  em: EntityManager,
  scope: VisitPaymentFieldScope,
): Promise<void> {
  await ensureVisitPaymentFieldDefinitions({
    ensure: async (sets, targetScope) => {
      await ensureCustomFieldDefinitions(em, sets, targetScope)
    },
  }, scope)
}
