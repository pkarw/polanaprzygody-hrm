'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CalendarHeart, Clock3, Mail, Menu, Phone } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import '../theme.css'

const PHONE_NUMBER = '+48 790 512 258'

export function PublicLayout({ children }: { children: ReactNode }) {
  const t = useT()
  return (
    <div className="pp-shell flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="pp-focus sr-only z-modal-elevated rounded-md bg-background px-4 py-2 text-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        {t('public_booking.site.skipToContent')}
      </a>
      <header className="border-b border-border/70 bg-background/95 backdrop-blur">
        <div className="mx-auto flex min-h-20 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link href="/" className="pp-focus flex items-center gap-3 rounded-md" aria-label={t('public_booking.site.homeAria')}>
            <span className="pp-highlight flex size-11 items-center justify-center rounded-full" aria-hidden="true">
              <CalendarHeart className="size-6" />
            </span>
            <span>
              <span className="block font-semibold tracking-tight">Polana Przygody</span>
              <span className="hidden text-xs text-muted-foreground sm:block">{t('public_booking.site.subtitle')}</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-7 md:flex" aria-label={t('public_booking.site.navigation')}>
            <Link className="pp-focus rounded-sm text-sm font-medium hover:text-primary" href="/">{t('public_booking.site.nav.home')}</Link>
            <Link className="pp-focus rounded-sm text-sm font-medium hover:text-primary" href="/cennik">{t('public_booking.site.nav.pricing')}</Link>
            <a className="pp-focus rounded-sm text-sm font-medium hover:text-primary" href="#contact">{t('public_booking.site.nav.contact')}</a>
          </nav>
          <Button asChild size="lg" className="pp-focus hidden sm:inline-flex">
            <Link href="/cennik">{t('public_booking.site.book')}</Link>
          </Button>
          <Button asChild variant="outline" size="icon" className="pp-focus md:hidden">
            <Link href="/cennik" aria-label={t('public_booking.site.openPricing')}>
              <Menu aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </header>
      <main id="main-content" className="flex-1">{children}</main>
      <footer id="contact" className="bg-primary text-primary-foreground">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-3 lg:px-8">
          <div>
            <p className="font-semibold">Polana Przygody</p>
            <p className="mt-2 max-w-sm text-sm text-primary-foreground/80">{t('public_booking.site.footerAbout')}</p>
          </div>
          <address className="space-y-3 text-sm not-italic">
            <a className="pp-focus flex items-center gap-2 rounded-sm hover:underline" href={`tel:${PHONE_NUMBER.replace(/\s/g, '')}`}>
              <Phone className="size-4" aria-hidden="true" /> {PHONE_NUMBER}
            </a>
            <a className="pp-focus flex items-center gap-2 rounded-sm hover:underline" href="mailto:info@polanaprzygody.pl">
              <Mail className="size-4" aria-hidden="true" /> info@polanaprzygody.pl
            </a>
            <p className="flex items-start gap-2">
              <Clock3 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{t('public_booking.site.openingWeek')}<br />{t('public_booking.site.openingSaturday')}</span>
            </p>
          </address>
          <div className="flex flex-col items-start gap-3 text-sm md:items-end">
            <a className="pp-focus rounded-sm hover:underline" href="https://polanaprzygody.pl/regulamin-swiadczenia-uslug">{t('public_booking.site.terms')}</a>
            <a className="pp-focus rounded-sm hover:underline" href="https://polanaprzygody.pl/polityka-prywatnosci">{t('public_booking.site.privacy')}</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
