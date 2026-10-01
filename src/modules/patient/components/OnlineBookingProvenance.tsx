'use client'

import { useQuery } from '@tanstack/react-query'
import { CalendarCheck2, CheckCircle2, MailCheck, RefreshCw } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import type { PatientVisitAccess } from './usePatientVisitAccess'

type OnlineBookingProvenanceResponse = {
  onlineBooking: {
    submittedAt: string
    termsAcceptedAt: string
    privacyPolicyAcceptedAt: string
    confirmationEmailSentAt: string | null
  } | null
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function OnlineBookingProvenance({ visitId, access }: { visitId: string; access: PatientVisitAccess }) {
  const t = useT()
  const query = useQuery<OnlineBookingProvenanceResponse>({
    queryKey: ['public-booking', 'provenance', visitId],
    queryFn: () => readApiResultOrThrow(`/api/public-booking/visits/${encodeURIComponent(visitId)}/provenance`),
    enabled: access.status === 'ready' && access.canView,
  })
  if (access.status !== 'ready' || !access.canView) return null
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border bg-muted/30 px-4 py-3 text-sm text-muted-foreground" role="status" aria-live="polite">
        <Spinner className="size-4" /> {t('patient.visits.onlineBooking.loading')}
      </div>
    )
  }
  if (query.error) {
    return (
      <Alert status="warning">
        <AlertTitle>{t('patient.visits.onlineBooking.errorTitle')}</AlertTitle>
        <AlertDescription>
          <p>{t('patient.visits.onlineBooking.errorDescription')}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => { void query.refetch() }}>
            <RefreshCw aria-hidden="true" /> {t('patient.common.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  const provenance = query.data?.onlineBooking
  if (!provenance) return null
  return (
    <section className="rounded-xl border bg-card p-4" aria-labelledby="online-booking-title" data-online-booking-provenance>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="online-booking-title" className="flex items-center gap-2 text-base font-semibold">
          <CalendarCheck2 className="size-5 text-primary" aria-hidden="true" />
          {t('patient.visits.onlineBooking.title')}
        </h2>
        <StatusBadge variant="info" appearance="light">{t('patient.visits.onlineBooking.badge')}</StatusBadge>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t('patient.visits.onlineBooking.submittedAt')}</dt>
          <dd className="mt-1 font-medium">{formatTimestamp(provenance.submittedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('patient.visits.onlineBooking.email')}</dt>
          <dd className="mt-1 flex items-center gap-2 font-medium">
            <MailCheck className="size-4 text-primary" aria-hidden="true" />
            {provenance.confirmationEmailSentAt
              ? t('patient.visits.onlineBooking.emailSent', { at: formatTimestamp(provenance.confirmationEmailSentAt) })
              : t('patient.visits.onlineBooking.emailPending')}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">{t('patient.visits.onlineBooking.consents')}</dt>
          <dd className="mt-2 flex flex-wrap gap-2">
            <StatusBadge variant="success" appearance="light"><CheckCircle2 aria-hidden="true" /> {t('patient.visits.onlineBooking.termsAccepted')}</StatusBadge>
            <StatusBadge variant="success" appearance="light"><CheckCircle2 aria-hidden="true" /> {t('patient.visits.onlineBooking.privacyAccepted')}</StatusBadge>
          </dd>
        </div>
      </dl>
    </section>
  )
}
