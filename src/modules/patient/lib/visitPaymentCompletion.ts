export type CheckoutTransactionCompletedPayload = {
  transactionId: string
  linkId: string
  status: string
  occurredAt?: string | null
  tenantId: string
  organizationId: string
}

export type PaymentCompletionDependencies = {
  findVisitsByPaymentLink(
    linkId: string,
    scope: { tenantId: string; organizationId: string },
  ): Promise<Array<Record<string, unknown>>>
  setVisitPaymentCompleted(
    visitId: string,
    receivedAt: string,
    scope: { tenantId: string; organizationId: string },
  ): Promise<void>
}

function readString(values: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = values[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export async function applyPaymentCompletion(
  payload: CheckoutTransactionCompletedPayload,
  dependencies: PaymentCompletionDependencies,
): Promise<'ignored' | 'unchanged' | 'updated'> {
  if (!payload.linkId || !payload.tenantId || !payload.organizationId || payload.status !== 'completed') {
    return 'ignored'
  }
  const scope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
  const matches = await dependencies.findVisitsByPaymentLink(payload.linkId, scope)
  if (matches.length === 0) return 'ignored'
  if (matches.length !== 1) {
    throw new Error('Multiple scoped patient visits reference the completed checkout link')
  }
  const visit = matches[0]!
  const visitId = readString(visit, 'id')
  if (!visitId) throw new Error('A payment-linked visit has no identifier')
  const status = readString(visit, 'cf_payment_link_status', 'cf:payment_link_status')
  const receivedAt = readString(visit, 'cf_payment_received_at', 'cf:payment_received_at')
  if (status === 'completed' && receivedAt) return 'unchanged'
  const occurredAt = payload.occurredAt && !Number.isNaN(Date.parse(payload.occurredAt))
    ? new Date(payload.occurredAt).toISOString()
    : new Date().toISOString()
  await dependencies.setVisitPaymentCompleted(visitId, receivedAt ?? occurredAt, scope)
  return 'updated'
}
