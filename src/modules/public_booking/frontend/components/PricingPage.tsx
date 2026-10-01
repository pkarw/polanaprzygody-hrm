'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, BadgePercent, CalendarX2, Clock3, RefreshCw } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import type { PublicBookingService } from '../../lib/publicDiscovery'
import { PublicLayout } from './PublicLayout'

function formatPrice(amount: string, currency: string): string {
  const value = Number(amount)
  if (!Number.isFinite(value)) return `${amount} ${currency}`
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value)
}

export function PricingPage() {
  const t = useT()
  const [services, setServices] = useState<PublicBookingService[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  const load = useCallback(async (signal?: AbortSignal) => {
    setStatus('loading')
    try {
      const response = await fetch('/api/public/booking/services', { signal, headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !Array.isArray(payload)) throw new Error('services_unavailable')
      setServices(payload as PublicBookingService[])
      setStatus('ready')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  return (
    <PublicLayout>
      <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wider text-primary">{t('public_booking.pricing.eyebrow')}</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{t('public_booking.pricing.title')}</h1>
          <p className="mt-4 text-base leading-7 text-muted-foreground">{t('public_booking.pricing.description')}</p>
        </div>

        <div className="mt-10" aria-live="polite" aria-busy={status === 'loading'}>
          {status === 'loading' ? (
            <LoadingMessage label={t('public_booking.pricing.loading')} className="min-h-24 justify-center" />
          ) : null}
          {status === 'error' ? (
            <ErrorMessage
              label={t('public_booking.pricing.errorTitle')}
              description={t('public_booking.pricing.errorDescription')}
              action={(
                <Button type="button" variant="outline" size="sm" onClick={() => void load()} className="pp-focus">
                  <RefreshCw aria-hidden="true" /> {t('public_booking.common.retry')}
                </Button>
              )}
            />
          ) : null}
          {status === 'ready' && services.length === 0 ? (
            <EmptyState
              icon={<CalendarX2 className="size-7" />}
              title={t('public_booking.pricing.emptyTitle')}
              description={t('public_booking.pricing.emptyDescription')}
              actions={(
                <Button asChild variant="outline" className="pp-focus">
                  <a href="tel:+48790512258">{t('public_booking.pricing.callUs')}</a>
                </Button>
              )}
            />
          ) : null}
          {status === 'ready' && services.length > 0 ? (
            <div className="grid gap-6 md:grid-cols-2">
              {services.map((service) => (
                <article key={service.id} className="flex min-h-72 flex-col rounded-2xl border bg-card p-6 shadow-sm sm:p-7">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                      {service.category || t('public_booking.pricing.categoryFallback')}
                    </span>
                    {service.price.isPromotion ? (
                      <span className="pp-highlight inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold">
                        <BadgePercent className="size-3.5" aria-hidden="true" /> {t('public_booking.pricing.promotion')}
                      </span>
                    ) : null}
                  </div>
                  <h2 className="mt-5 text-xl font-semibold">{service.title}</h2>
                  <p className="mt-3 line-clamp-3 text-sm leading-6 text-muted-foreground">{service.description}</p>
                  <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock3 className="size-4" aria-hidden="true" />
                    {t('public_booking.pricing.duration', { minutes: service.durationMinutes })}
                  </p>
                  <div className="mt-auto flex flex-col gap-4 border-t pt-5 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      {service.price.wasAmount ? (
                        <p className="text-sm text-muted-foreground line-through">
                          {formatPrice(service.price.wasAmount, service.price.currency)}
                        </p>
                      ) : null}
                      <p className="text-2xl font-semibold text-primary">
                        {formatPrice(service.price.amount, service.price.currency)}
                      </p>
                    </div>
                    <Button asChild className="pp-focus sm:self-center">
                      <Link href={`/umow-sie/${encodeURIComponent(service.id)}`}>
                        {t('public_booking.site.book')} <ArrowRight aria-hidden="true" />
                      </Link>
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </PublicLayout>
  )
}
