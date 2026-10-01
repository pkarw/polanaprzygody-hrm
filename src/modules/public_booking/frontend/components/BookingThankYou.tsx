'use client'

import Link from 'next/link'
import { CalendarCheck2, Phone } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { PublicLayout } from './PublicLayout'

export function BookingThankYou() {
  const t = useT()
  return (
    <PublicLayout>
      <section className="mx-auto flex min-h-96 w-full max-w-3xl items-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full rounded-3xl border bg-card p-7 text-center shadow-sm sm:p-12">
          <span className="mx-auto inline-flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CalendarCheck2 className="size-8" aria-hidden="true" />
          </span>
          <p className="mt-6 text-sm font-semibold uppercase tracking-wider text-primary">{t('public_booking.thankYou.eyebrow')}</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{t('public_booking.thankYou.title')}</h1>
          <p className="mx-auto mt-4 max-w-xl leading-7 text-muted-foreground">{t('public_booking.thankYou.description')}</p>
          <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground">{t('public_booking.thankYou.next')}</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild size="lg"><Link href="/">{t('public_booking.thankYou.home')}</Link></Button>
            <Button asChild size="lg" variant="outline"><a href="tel:+48790512258"><Phone aria-hidden="true" /> +48 790 512 258</a></Button>
          </div>
        </div>
      </section>
    </PublicLayout>
  )
}
