import type { PatientVisitPaymentEmailDeliveryStatus } from '../data/entities'

export const VISIT_PAYMENT_EMAIL_PROVIDER_TIMEOUT_MS = 30_000

export type VisitPaymentEmailDelivery = {
  recipient: string
  paymentUrl: string
}

export type VisitPaymentEmailDeliveryState = {
  status: PatientVisitPaymentEmailDeliveryStatus
  claimJobId: string | null
}

export type VisitPaymentEmailLoadResult =
  | { ok: true; delivery: VisitPaymentEmailDelivery }
  | { ok: false; code: string }

export type VisitPaymentEmailDeliveryDependencies = {
  jobId: string
  readState(): Promise<VisitPaymentEmailDeliveryState | null>
  loadDelivery(): Promise<VisitPaymentEmailLoadResult>
  claimSending(jobId: string): Promise<boolean>
  markSent(jobId: string): Promise<boolean>
  markFailed(code: string): Promise<boolean>
  markAmbiguous(jobId: string, code: string): Promise<boolean>
  send(delivery: VisitPaymentEmailDelivery): Promise<void>
  providerTimeoutMs?: number
  logTerminal(status: 'failed' | 'ambiguous', code: string, errorName?: string): void
}

export type VisitPaymentEmailAbandonmentDependencies = {
  markPendingFailed(code: string): Promise<boolean>
  markOwnedSendingAmbiguous(jobId: string, code: string): Promise<boolean>
  logTerminal(status: 'failed' | 'ambiguous', code: string): void
}

class EmailProviderTimeoutError extends Error {
  constructor() {
    super('Email provider call exceeded its deadline')
    this.name = 'EmailProviderTimeoutError'
  }
}

async function sendWithTimeout(send: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const provider = Promise.resolve().then(send)
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new EmailProviderTimeoutError()), timeoutMs)
  })
  try {
    // Promise.race installs rejection handlers on both inputs, so a provider that
    // rejects after the deadline cannot become an unhandled rejection.
    await Promise.race([provider, deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function recoverAbandonedVisitPaymentEmail(
  abandonedJobId: string | null,
  deps: VisitPaymentEmailAbandonmentDependencies,
): Promise<void> {
  if (await deps.markPendingFailed('queue_job_abandoned_before_claim')) {
    deps.logTerminal('failed', 'queue_job_abandoned_before_claim')
    return
  }
  if (
    abandonedJobId
    && await deps.markOwnedSendingAmbiguous(abandonedJobId, 'queue_job_abandoned_after_claim')
  ) {
    deps.logTerminal('ambiguous', 'queue_job_abandoned_after_claim')
  }
}

export async function processVisitPaymentEmailDelivery(
  deps: VisitPaymentEmailDeliveryDependencies,
): Promise<void> {
  const state = await deps.readState()
  if (state === null) {
    deps.logTerminal('failed', 'delivery_missing')
    return
  }
  if (state.status === 'sent' || state.status === 'failed' || state.status === 'ambiguous') return
  if (state.status === 'sending') {
    // Only the queue job that committed the claim may resolve an interrupted send.
    // A duplicate job must not poison the live owner's operation.
    if (state.claimJobId !== deps.jobId) return
    if (await deps.markAmbiguous(deps.jobId, 'retry_after_sending_claim')) {
      deps.logTerminal('ambiguous', 'retry_after_sending_claim')
    }
    return
  }
  const loaded = await deps.loadDelivery()
  if (!loaded.ok) {
    if (await deps.markFailed(loaded.code)) deps.logTerminal('failed', loaded.code)
    return
  }
  if (!await deps.claimSending(deps.jobId)) return
  try {
    await sendWithTimeout(
      () => deps.send(loaded.delivery),
      deps.providerTimeoutMs ?? VISIT_PAYMENT_EMAIL_PROVIDER_TIMEOUT_MS,
    )
  } catch (error) {
    const code = error instanceof EmailProviderTimeoutError
      ? 'provider_timeout'
      : 'provider_acceptance_unknown'
    if (await deps.markAmbiguous(deps.jobId, code)) {
      deps.logTerminal('ambiguous', code, error instanceof Error ? error.name : 'unknown')
    }
    return
  }
  await deps.markSent(deps.jobId)
}
