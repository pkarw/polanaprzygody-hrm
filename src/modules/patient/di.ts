import { asFunction } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createPatientReferenceService } from './lib/patientReferenceService'
import { createPatientAvailabilityService } from './lib/patientAvailabilityService'
import { createVisitPaymentLinkService } from './lib/visitPaymentLinkService'
import { createVisitPaymentLinkEmailService } from './lib/visitPaymentEmail'

/** DI token this module owns. Exported so callers and tests name it once. */
export const PATIENT_REFERENCE_SERVICE = 'patientReferenceService' as const
export const PATIENT_AVAILABILITY_SERVICE = 'patientAvailabilityService' as const
export const VISIT_PAYMENT_LINK_SERVICE = 'visitPaymentLinkService' as const
export const VISIT_PAYMENT_LINK_EMAIL_SERVICE = 'visitPaymentLinkEmailService' as const

export function register(container: AppContainer) {
  container.register({
    // `.scoped()` rather than `.singleton()`: the service closes over the request
    // container's `em`, and a singleton would pin one request's EntityManager — and with
    // it one request's tenant — for the life of the process. For a service whose whole
    // job is scoped reference resolution that would be the worst possible lifetime.
    [PATIENT_REFERENCE_SERVICE]: asFunction(createPatientReferenceService).scoped(),
    [PATIENT_AVAILABILITY_SERVICE]: asFunction(createPatientAvailabilityService).scoped(),
    [VISIT_PAYMENT_LINK_SERVICE]: asFunction(createVisitPaymentLinkService).scoped(),
    [VISIT_PAYMENT_LINK_EMAIL_SERVICE]: asFunction(createVisitPaymentLinkEmailService).scoped(),
  })
}

export default register
