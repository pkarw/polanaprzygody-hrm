import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('patient').child({ component: 'calendar-store' })

export async function readPatientCalendarStore<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    // Log before converting. A `CrudHttpError` skips `toPatientErrorResponse`'s `logger.error`
    // branch, so without this the 503 is the only trace that anything happened — and a 503
    // reads as retryable, which is wrong for a permanent failure such as an undecryptable row
    // after a key rotation.
    //
    // The error CLASS only, never its message: a driver message can quote the offending row,
    // and this module's rows hold clinical data — the same reason
    // `toPatientErrorResponse` refuses to put a database fragment in a response body.
    logger.error('Patient calendar store read failed', {
      errorName: error instanceof Error ? error.name : typeof error,
    })
    throw new CrudHttpError(503, {
      error: 'The patient calendar data store is unavailable',
      code: 'visit_calendar_store_unavailable',
    })
  }
}
