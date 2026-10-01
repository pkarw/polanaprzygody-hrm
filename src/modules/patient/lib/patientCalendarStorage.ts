import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

export async function readPatientCalendarStore<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch {
    throw new CrudHttpError(503, {
      error: 'The patient calendar data store is unavailable',
      code: 'visit_calendar_store_unavailable',
    })
  }
}
