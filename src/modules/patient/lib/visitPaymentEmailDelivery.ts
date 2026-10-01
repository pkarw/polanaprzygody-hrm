import type { PatientVisitPaymentEmailDeliveryStatus } from '../data/entities'

export type VisitPaymentEmailDelivery = {
  recipient: string
  paymentUrl: string
}

export type VisitPaymentEmailLoadResult =
  | { ok: true; delivery: VisitPaymentEmailDelivery }
  | { ok: false; code: string }

export type VisitPaymentEmailDeliveryDependencies = {
  readStatus(): Promise<PatientVisitPaymentEmailDeliveryStatus | null>
  loadDelivery(): Promise<VisitPaymentEmailLoadResult>
  claimSending(): Promise<boolean>
  markSent(): Promise<boolean>
  markFailed(code: string): Promise<boolean>
  markAmbiguous(code: string): Promise<boolean>
  send(delivery: VisitPaymentEmailDelivery): Promise<void>
  logTerminal(status: 'failed' | 'ambiguous', code: string, errorName?: string): void
}

export async function processVisitPaymentEmailDelivery(
  deps: VisitPaymentEmailDeliveryDependencies,
): Promise<void> {
  const status = await deps.readStatus()
  if (status === null) {
    deps.logTerminal('failed', 'delivery_missing')
    return
  }
  if (status === 'sent' || status === 'failed' || status === 'ambiguous') return
  if (status === 'sending') {
    if (await deps.markAmbiguous('retry_after_sending_claim')) {
      deps.logTerminal('ambiguous', 'retry_after_sending_claim')
    }
    return
  }
  const loaded = await deps.loadDelivery()
  if (!loaded.ok) {
    if (await deps.markFailed(loaded.code)) deps.logTerminal('failed', loaded.code)
    return
  }
  if (!await deps.claimSending()) {
    const observed = await deps.readStatus()
    if (observed === 'sending' && await deps.markAmbiguous('concurrent_sending_claim')) {
      deps.logTerminal('ambiguous', 'concurrent_sending_claim')
    }
    return
  }
  try {
    await deps.send(loaded.delivery)
  } catch (error) {
    if (await deps.markAmbiguous('provider_acceptance_unknown')) {
      deps.logTerminal(
        'ambiguous',
        'provider_acceptance_unknown',
        error instanceof Error ? error.name : 'unknown',
      )
    }
    return
  }
  await deps.markSent()
}
