import type { BookingConfirmationEmailDeliveryStatus } from '../data/entities'

export type BookingConfirmationDelivery = {
  recipient: string
  requesterName: string
  service: string
  startsAt: Date
  timeZone: string
  room: string
}

export type BookingDeliveryLoadResult =
  | { ok: true; delivery: BookingConfirmationDelivery }
  | { ok: false; code: string }

export type BookingConfirmationDeliveryDependencies = {
  readStatus(): Promise<BookingConfirmationEmailDeliveryStatus | null>
  loadDelivery(): Promise<BookingDeliveryLoadResult>
  claimSending(): Promise<boolean>
  markSent(): Promise<boolean>
  markFailed(code: string): Promise<boolean>
  markAmbiguous(code: string): Promise<boolean>
  send(delivery: BookingConfirmationDelivery): Promise<void>
  logTerminal(status: 'failed' | 'ambiguous', code: string, errorName?: string): void
}

/** Claim is committed before provider I/O; finalization begins only after it settles. */
export async function processBookingConfirmationDelivery(
  deps: BookingConfirmationDeliveryDependencies,
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
