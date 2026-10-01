'use client'

import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, CalendarDays, ChevronRight, Clock3, Loader2, Phone, RefreshCw, Send, UserRoundSearch } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Avatar } from '@open-mercato/ui/primitives/avatar'
import { Button } from '@open-mercato/ui/primitives/button'
import { Checkbox } from '@open-mercato/ui/primitives/checkbox'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import type {
  PublicBookingAvailabilityResult,
  PublicBookingService,
  PublicBookingSlot,
  PublicBookingTherapist,
} from '../../lib/publicDiscovery'
import {
  publicBookingDateWindow,
  PUBLIC_BOOKING_TIME_ZONE as FACILITY_TIME_ZONE,
} from '../../lib/publicBookingDateWindow'
import { PublicLayout } from './PublicLayout'

export { publicBookingDateWindow } from '../../lib/publicBookingDateWindow'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type IntakeValues = {
  requesterFirstName: string
  requesterLastName: string
  requesterEmail: string
  requesterPhone: string
  patientFirstName: string
  patientLastName: string
  street: string
  postalCode: string
  city: string
  country: string
  terms: boolean
  privacyPolicy: boolean
}

const EMPTY_INTAKE: IntakeValues = {
  requesterFirstName: '', requesterLastName: '', requesterEmail: '', requesterPhone: '',
  patientFirstName: '', patientLastName: '', street: '', postalCode: '', city: '', country: 'PL',
  terms: false, privacyPolicy: false,
}

function dayKey(value: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FACILITY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

function dayLabel(value: Date): { weekday: string; date: string } {
  return {
    weekday: new Intl.DateTimeFormat('pl-PL', { timeZone: FACILITY_TIME_ZONE, weekday: 'short' }).format(value),
    date: new Intl.DateTimeFormat('pl-PL', { timeZone: FACILITY_TIME_ZONE, day: '2-digit', month: '2-digit' }).format(value),
  }
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone: FACILITY_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { accept: 'application/json' } })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`request_${response.status}`)
  return payload as T
}

export function BookingWizard({ productId }: { productId: string }) {
  const t = useT()
  const router = useRouter()
  const [service, setService] = useState<PublicBookingService | null>(null)
  const [therapists, setTherapists] = useState<PublicBookingTherapist[]>([])
  const [therapistState, setTherapistState] = useState<LoadState>('loading')
  const [selectedTherapist, setSelectedTherapist] = useState<PublicBookingTherapist | null>(null)
  const [availabilityRequest, setAvailabilityRequest] = useState(0)
  const [availability, setAvailability] = useState<PublicBookingAvailabilityResult>({ slots: [] })
  const [availabilityState, setAvailabilityState] = useState<LoadState>('idle')
  const [selectedDay, setSelectedDay] = useState<string>(() => dayKey(publicBookingDateWindow().from))
  const [selectedSlot, setSelectedSlot] = useState<PublicBookingSlot | null>(null)
  const [intake, setIntake] = useState<IntakeValues>(EMPTY_INTAKE)
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'error'>('idle')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const dayStripRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const termsRef = useRef<HTMLButtonElement>(null)
  const privacyRef = useRef<HTMLButtonElement>(null)
  const submissionRef = useRef<{ payload: string; key: string } | null>(null)

  const days = useMemo(() => {
    return publicBookingDateWindow().days
  }, [])
  const slotsByDay = useMemo(() => {
    const grouped = new Map<string, PublicBookingSlot[]>()
    for (const slot of availability.slots) {
      const key = dayKey(slot.startsAt)
      const bucket = grouped.get(key) ?? []
      bucket.push(slot)
      grouped.set(key, bucket)
    }
    return grouped
  }, [availability.slots])
  const visibleSlots = slotsByDay.get(selectedDay) ?? []

  useEffect(() => {
    const controller = new AbortController()
    setTherapistState('loading')
    void Promise.all([
      readJson<PublicBookingService[]>('/api/public/booking/services', controller.signal),
      readJson<PublicBookingTherapist[]>(
        `/api/public/booking/services/${encodeURIComponent(productId)}/therapists`,
        controller.signal,
      ),
    ]).then(([services, loadedTherapists]) => {
      setService(services.find((item) => item.id === productId) ?? null)
      setTherapists(loadedTherapists)
      setTherapistState('ready')
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setTherapistState('error')
    })
    return () => controller.abort()
  }, [productId])

  useEffect(() => {
    if (!selectedTherapist) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const { from, to } = publicBookingDateWindow()
      setAvailabilityState('loading')
      setSelectedSlot(null)
      const query = new URLSearchParams({
        productId,
        teamMemberId: selectedTherapist.id,
        from: from.toISOString(),
        to: to.toISOString(),
      })
      void readJson<PublicBookingAvailabilityResult>(
        `/api/public/booking/availability?${query.toString()}`,
        controller.signal,
      ).then((result) => {
        setAvailability(result)
        setAvailabilityState('ready')
        const firstAvailableDay = result.slots[0] ? dayKey(result.slots[0].startsAt) : dayKey(from)
        setSelectedDay(firstAvailableDay)
        window.requestAnimationFrame(() => {
          dayStripRef.current?.querySelector<HTMLElement>(`[data-day="${firstAvailableDay}"]`)?.focus()
        })
      }).catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setAvailability({ slots: [] })
        setAvailabilityState('error')
      })
    }, 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [availabilityRequest, productId, selectedTherapist])

  function chooseTherapist(therapist: PublicBookingTherapist): void {
    setSelectedTherapist(therapist)
    setAvailabilityRequest((current) => current + 1)
    setAvailability({ slots: [] })
    setAvailabilityState('loading')
  }

  function updateIntake<K extends keyof IntakeValues>(key: K, value: IntakeValues[K]): void {
    setIntake((current) => ({ ...current, [key]: value }))
    setSubmitError(null)
  }

  async function submitBooking(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!service || !selectedTherapist || !selectedSlot || submitState === 'submitting') return
    if (!formRef.current?.checkValidity()) {
      formRef.current?.querySelector<HTMLElement>(':invalid')?.focus()
      formRef.current?.reportValidity()
      return
    }
    if (!intake.terms || !intake.privacyPolicy) {
      setSubmitError(t('public_booking.booking.errors.consents'))
      queueMicrotask(() => (intake.terms ? privacyRef.current : termsRef.current)?.focus())
      return
    }
    const body = {
      productId: service.id,
      teamMemberId: selectedTherapist.id,
      startsAt: selectedSlot.startsAt,
      endsAt: selectedSlot.endsAt,
      timeZone: FACILITY_TIME_ZONE,
      requester: {
        firstName: intake.requesterFirstName,
        lastName: intake.requesterLastName,
        ...(intake.requesterEmail.trim() ? { email: intake.requesterEmail } : {}),
        phone: intake.requesterPhone,
      },
      patient: {
        firstName: intake.patientFirstName,
        lastName: intake.patientLastName,
        address: {
          street: intake.street,
          postalCode: intake.postalCode,
          city: intake.city,
          country: intake.country,
        },
      },
      consents: { terms: true, privacyPolicy: true },
    }
    const payload = JSON.stringify(body)
    if (submissionRef.current?.payload !== payload) {
      submissionRef.current = { payload, key: crypto.randomUUID() }
    }
    setSubmitState('submitting')
    setSubmitError(null)
    try {
      const response = await fetch('/api/public/booking/requests', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': submissionRef.current.key,
        },
        body: payload,
      })
      if (response.ok) {
        router.push('/umow-sie/dziekujemy')
        return
      }
      if (response.status === 409) {
        setSelectedSlot(null)
        setSubmitError(t('public_booking.booking.errors.409'))
        chooseTherapist(selectedTherapist)
        queueMicrotask(() => document.getElementById('availability-title')?.focus())
      } else {
        setSubmitError(t(`public_booking.booking.errors.${response.status}`))
      }
      setSubmitState('error')
    } catch {
      setSubmitError(t('public_booking.booking.errors.network'))
      setSubmitState('error')
    }
  }

  return (
    <PublicLayout>
      <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <Button asChild variant="ghost" className="pp-focus -ml-3">
          <Link href="/cennik"><ArrowLeft aria-hidden="true" /> {t('public_booking.booking.backToPricing')}</Link>
        </Button>
        <ol className="mt-6 grid gap-2 border-b pb-5 sm:grid-cols-3" aria-label={t('public_booking.booking.progress')}>
          {[1, 2, 3].map((step) => {
            const current = selectedSlot ? 3 : selectedTherapist ? 2 : 1
            return (
              <li
                key={step}
                aria-current={step === current ? 'step' : undefined}
                className={step === current ? 'font-semibold text-primary' : step < current ? 'text-foreground' : 'text-muted-foreground'}
              >
                <span className="mr-2 inline-flex size-7 items-center justify-center rounded-full border" aria-hidden="true">{step}</span>
                {t(`public_booking.booking.steps.${step}`)}
              </li>
            )
          })}
        </ol>

        <div className="mt-8" aria-live="polite">
          {service ? (
            <div className="mb-8">
              <p className="text-sm font-medium text-primary">{service.category}</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight">{service.title}</h1>
              <p className="mt-2 flex items-center gap-2 text-muted-foreground">
                <Clock3 className="size-4" aria-hidden="true" />
                {t('public_booking.pricing.duration', { minutes: service.durationMinutes })}
              </p>
            </div>
          ) : null}

          {therapistState === 'loading' ? (
            <LoadingMessage label={t('public_booking.booking.loadingTherapists')} className="min-h-24 justify-center" />
          ) : null}
          {therapistState === 'error' ? (
            <ErrorMessage
              label={t('public_booking.booking.serviceUnavailable')}
              description={t('public_booking.booking.returnToPricing')}
              action={<Button asChild variant="outline"><Link href="/cennik">{t('public_booking.booking.backToPricing')}</Link></Button>}
            />
          ) : null}
          {therapistState === 'ready' && therapists.length === 0 ? (
            <EmptyState
              icon={<UserRoundSearch className="size-7" />}
              title={t('public_booking.booking.noTherapists')}
              description={t('public_booking.booking.noTherapistsDescription')}
              actions={<Button asChild variant="outline"><Link href="/cennik">{t('public_booking.booking.backToPricing')}</Link></Button>}
            />
          ) : null}
          {therapistState === 'ready' && therapists.length > 0 ? (
            <div>
              <h2 className="text-xl font-semibold">{t('public_booking.booking.chooseTherapist')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{t('public_booking.booking.chooseTherapistDescription')}</p>
              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {therapists.map((therapist) => {
                  const selected = selectedTherapist?.id === therapist.id
                  return (
                    <Button
                      key={therapist.id}
                      type="button"
                      variant="outline"
                      aria-pressed={selected}
                      className={`pp-focus h-auto min-h-56 w-full flex-col justify-start whitespace-normal p-5 text-center ${selected ? 'border-primary shadow-focus' : ''}`}
                      onClick={() => chooseTherapist(therapist)}
                    >
                      <Avatar label={therapist.displayName} src={therapist.photoUrl} size={80} ring={selected ? 'accent' : false} />
                      <span className="mt-3 text-base font-semibold">{therapist.displayName}</span>
                      {therapist.specializations?.length ? (
                        <span className="text-xs text-muted-foreground">{therapist.specializations.join(' · ')}</span>
                      ) : null}
                      {therapist.shortBio ? <span className="line-clamp-3 text-xs font-normal text-muted-foreground">{therapist.shortBio}</span> : null}
                    </Button>
                  )
                })}
              </div>
            </div>
          ) : null}

          {selectedTherapist ? (
            <section className="mt-10 border-t pt-8" aria-labelledby="availability-title">
              <h2 id="availability-title" tabIndex={-1} className="text-xl font-semibold outline-none">{t('public_booking.booking.chooseTime')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{t('public_booking.booking.chooseTimeDescription')}</p>
              {availabilityState === 'loading' ? (
                <LoadingMessage label={t('public_booking.booking.loadingAvailability')} className="mt-5 min-h-20 justify-center" />
              ) : null}
              {availabilityState === 'error' ? (
                <ErrorMessage
                  className="mt-5"
                  label={t('public_booking.booking.availabilityError')}
                  description={t('public_booking.booking.availabilityErrorDescription')}
                  action={(
                    <Button type="button" variant="outline" size="sm" onClick={() => chooseTherapist(selectedTherapist)}>
                      <RefreshCw aria-hidden="true" /> {t('public_booking.common.retry')}
                    </Button>
                  )}
                />
              ) : null}
              {availabilityState === 'ready' && availability.degraded ? (
                <Alert status="warning" className="mt-5">
                  <AlertTitle>{t('public_booking.booking.degradedTitle')}</AlertTitle>
                  <AlertDescription>
                    <p>{t('public_booking.booking.degradedDescription')}</p>
                    <a className="mt-2 inline-flex items-center gap-2 font-semibold underline" href="tel:+48790512258">
                      <Phone className="size-4" aria-hidden="true" /> +48 790 512 258
                    </a>
                  </AlertDescription>
                </Alert>
              ) : null}
              {availabilityState === 'ready' && !availability.degraded && availability.slots.length === 0 ? (
                <EmptyState
                  className="mt-5"
                  icon={<CalendarDays className="size-7" />}
                  title={t('public_booking.booking.noSlots')}
                  description={t('public_booking.booking.noSlotsDescription')}
                />
              ) : null}
              {availabilityState === 'ready' && availability.slots.length > 0 ? (
                <div className="mt-5 grid gap-6 lg:grid-cols-3">
                  <div ref={dayStripRef} className="flex gap-2 overflow-x-auto pb-3 lg:col-span-2" role="list" aria-label={t('public_booking.booking.availableDays')}>
                    {days.map((day) => {
                      const key = dayKey(day)
                      const label = dayLabel(day)
                      const count = slotsByDay.get(key)?.length ?? 0
                      const selected = selectedDay === key
                      return (
                        <div key={key} role="listitem">
                          <Button
                            type="button"
                            data-day={key}
                            variant={selected ? 'default' : 'outline'}
                            aria-pressed={selected}
                            disabled={count === 0}
                            className="pp-focus h-auto min-w-20 flex-col gap-0 px-3 py-2"
                            onClick={() => { setSelectedDay(key); setSelectedSlot(null) }}
                          >
                            <span className="text-xs capitalize">{label.weekday}</span>
                            <span>{label.date}</span>
                            <span className="text-xs opacity-75">{t('public_booking.booking.slotCount', { count })}</span>
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                  <div className="rounded-2xl border bg-card p-4" aria-live="polite">
                    <h3 className="font-semibold">{t('public_booking.booking.timesForDay', { date: dayLabel(new Date(`${selectedDay}T12:00:00Z`)).date })}</h3>
                    <div className="mt-3 grid max-h-80 grid-cols-2 gap-2 overflow-y-auto pr-1 lg:grid-cols-1">
                      {visibleSlots.map((slot) => {
                        const selected = selectedSlot?.startsAt === slot.startsAt
                        return (
                          <Button
                            key={slot.startsAt}
                            type="button"
                            variant={selected ? 'default' : 'outline'}
                            aria-pressed={selected}
                            className="pp-focus justify-between"
                            onClick={() => setSelectedSlot(slot)}
                          >
                            {timeLabel(slot.startsAt)} <ChevronRight aria-hidden="true" />
                          </Button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
              {submitError && !selectedSlot ? (
                <Alert status="error" className="mt-6" aria-live="assertive">
                  <AlertTitle>{t('public_booking.booking.form.submitError')}</AlertTitle>
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              ) : null}
              {selectedSlot ? (
                <>
                  <Alert status="success" className="mt-6">
                    <AlertTitle>{t('public_booking.booking.slotSelected')}</AlertTitle>
                    <AlertDescription>{t('public_booking.booking.slotSelectedDescription', { time: timeLabel(selectedSlot.startsAt) })}</AlertDescription>
                  </Alert>
                  <form ref={formRef} noValidate className="mt-8 space-y-8 rounded-2xl border bg-card p-5 sm:p-7" onSubmit={(event) => { void submitBooking(event) }}>
                    <div>
                      <h2 className="text-xl font-semibold">{t('public_booking.booking.form.title')}</h2>
                      <p className="mt-2 text-sm text-muted-foreground">{t('public_booking.booking.form.description')}</p>
                    </div>
                    <fieldset className="space-y-4">
                      <legend className="text-base font-semibold">{t('public_booking.booking.form.requester')}</legend>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <BookingField id="requester-first-name" label={t('public_booking.booking.form.firstName')} value={intake.requesterFirstName} onChange={(value) => updateIntake('requesterFirstName', value)} autoComplete="given-name" />
                        <BookingField id="requester-last-name" label={t('public_booking.booking.form.lastName')} value={intake.requesterLastName} onChange={(value) => updateIntake('requesterLastName', value)} autoComplete="family-name" />
                        <BookingField id="requester-email" label={t('public_booking.booking.form.email')} value={intake.requesterEmail} onChange={(value) => updateIntake('requesterEmail', value)} type="email" required={false} autoComplete="email" />
                        <BookingField id="requester-phone" label={t('public_booking.booking.form.phone')} value={intake.requesterPhone} onChange={(value) => updateIntake('requesterPhone', value)} type="tel" autoComplete="tel" />
                      </div>
                    </fieldset>
                    <fieldset className="space-y-4">
                      <legend className="text-base font-semibold">{t('public_booking.booking.form.patient')}</legend>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <BookingField id="patient-first-name" label={t('public_booking.booking.form.firstName')} value={intake.patientFirstName} onChange={(value) => updateIntake('patientFirstName', value)} autoComplete="off" />
                        <BookingField id="patient-last-name" label={t('public_booking.booking.form.lastName')} value={intake.patientLastName} onChange={(value) => updateIntake('patientLastName', value)} autoComplete="off" />
                        <div className="sm:col-span-2"><BookingField id="patient-street" label={t('public_booking.booking.form.street')} value={intake.street} onChange={(value) => updateIntake('street', value)} autoComplete="street-address" /></div>
                        <BookingField id="patient-postal-code" label={t('public_booking.booking.form.postalCode')} value={intake.postalCode} onChange={(value) => updateIntake('postalCode', value)} autoComplete="postal-code" />
                        <BookingField id="patient-city" label={t('public_booking.booking.form.city')} value={intake.city} onChange={(value) => updateIntake('city', value)} autoComplete="address-level2" />
                        <BookingField id="patient-country" label={t('public_booking.booking.form.country')} value={intake.country} onChange={(value) => updateIntake('country', value.toUpperCase())} minLength={2} maxLength={2} autoComplete="country" />
                      </div>
                    </fieldset>
                    <fieldset className="space-y-4">
                      <legend className="text-base font-semibold">{t('public_booking.booking.form.consents')}</legend>
                      <ConsentField ref={termsRef} id="booking-terms" checked={intake.terms} onCheckedChange={(checked) => updateIntake('terms', checked)}>
                        {t('public_booking.booking.form.acceptTerms')}{' '}<a className="pp-focus rounded-sm font-medium underline" href="https://polanaprzygody.pl/regulamin-swiadczenia-uslug" target="_blank" rel="noreferrer">{t('public_booking.site.terms')}</a>
                      </ConsentField>
                      <ConsentField ref={privacyRef} id="booking-privacy" checked={intake.privacyPolicy} onCheckedChange={(checked) => updateIntake('privacyPolicy', checked)}>
                        {t('public_booking.booking.form.acceptPrivacy')}{' '}<a className="pp-focus rounded-sm font-medium underline" href="https://polanaprzygody.pl/polityka-prywatnosci" target="_blank" rel="noreferrer">{t('public_booking.site.privacy')}</a>
                      </ConsentField>
                    </fieldset>
                    {submitError ? (
                      <Alert status="error" aria-live="assertive">
                        <AlertTitle>{t('public_booking.booking.form.submitError')}</AlertTitle>
                        <AlertDescription>{submitError}</AlertDescription>
                      </Alert>
                    ) : null}
                    <Button type="submit" size="lg" className="pp-focus w-full sm:w-auto" disabled={submitState === 'submitting'}>
                      {submitState === 'submitting' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
                      {submitState === 'submitting' ? t('public_booking.booking.form.submitting') : t('public_booking.booking.form.submit')}
                    </Button>
                  </form>
                </>
              ) : null}
            </section>
          ) : null}
        </div>
      </section>
    </PublicLayout>
  )
}

function BookingField({ id, label, value, onChange, required = true, ...props }: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange' | 'required' | 'size'>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</Label>
      <Input id={id} value={value} required={required} onChange={(event) => onChange(event.target.value)} {...props} />
    </div>
  )
}

const ConsentField = React.forwardRef<HTMLButtonElement, {
  id: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: React.ReactNode
}>(function ConsentField({ id, checked, onCheckedChange, children }, ref) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox ref={ref} id={id} checked={checked} aria-required="true" onCheckedChange={(value) => onCheckedChange(value === true)} />
      <Label htmlFor={id} className="cursor-pointer text-sm font-normal leading-6">{children}<span aria-hidden="true"> *</span></Label>
    </div>
  )
})
