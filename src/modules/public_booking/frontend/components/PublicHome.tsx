'use client'

import Link from 'next/link'
import { ArrowRight, CalendarCheck2, HeartHandshake, Sparkles } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { PublicLayout } from './PublicLayout'

export function PublicHome() {
  const t = useT()
  return (
    <PublicLayout>
      <section className="pp-hero text-primary-foreground">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-3 lg:px-8 lg:py-28">
          <div className="max-w-3xl lg:col-span-2">
            <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-primary-foreground/10 px-3 py-1 text-sm font-medium">
              <Sparkles className="size-4" aria-hidden="true" />
              {t('public_booking.home.eyebrow')}
            </p>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
              {t('public_booking.home.title')}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-primary-foreground/85">
              {t('public_booking.home.description')}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="pp-focus pp-highlight hover:opacity-90">
                <Link href="/cennik">
                  {t('public_booking.home.primaryAction')} <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="pp-focus border-primary-foreground/60 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground">
                <a href="tel:+48790512258">{t('public_booking.home.callAction')}</a>
              </Button>
            </div>
          </div>
          <div className="pp-tint self-end rounded-3xl border border-primary-foreground/15 p-6 text-foreground shadow-lg sm:p-8">
            <HeartHandshake className="size-9 text-primary" aria-hidden="true" />
            <h2 className="mt-5 text-xl font-semibold">{t('public_booking.home.cardTitle')}</h2>
            <p className="mt-3 leading-7 text-muted-foreground">{t('public_booking.home.cardDescription')}</p>
          </div>
        </div>
      </section>
      <section className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-6 md:grid-cols-3">
          {[
            ['1', 'public_booking.home.steps.service'],
            ['2', 'public_booking.home.steps.date'],
            ['3', 'public_booking.home.steps.confirmation'],
          ].map(([number, key]) => (
            <article key={number} className="rounded-2xl border bg-card p-6 shadow-sm">
              <span className="pp-highlight inline-flex size-9 items-center justify-center rounded-full font-semibold">{number}</span>
              <p className="mt-4 font-medium">{t(key)}</p>
            </article>
          ))}
        </div>
        <div className="mt-10 flex items-center justify-center">
          <Button asChild variant="outline" size="lg" className="pp-focus">
            <Link href="/cennik">
              <CalendarCheck2 aria-hidden="true" /> {t('public_booking.home.viewPricing')}
            </Link>
          </Button>
        </div>
      </section>
    </PublicLayout>
  )
}
