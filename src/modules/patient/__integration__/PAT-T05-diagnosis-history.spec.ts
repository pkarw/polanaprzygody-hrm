import { expect, test } from '@playwright/test'
import {
  callApi,
  callApiOk,
  cleanupPatient,
  createPatient,
  listDiagnoses,
  login,
  newRequestId,
  requirePatient,
  type CreatedPatient,
} from './helpers/api'

const today = () => new Date().toISOString().slice(0, 10)

async function addDiagnosis(
  request: Parameters<typeof callApiOk>[0],
  actor: Awaited<ReturnType<typeof login>>,
  patientId: string,
  overrides: Record<string, unknown> = {},
) {
  return await callApiOk<{ id: string; updatedAt: string | null }>(
    request,
    'POST',
    '/api/patient/diagnoses',
    actor,
    {
      patientId,
      title: 'Ocena wstępna',
      description: 'Opis oceny wstępnej.',
      diagnosedOn: today(),
      clientRequestId: newRequestId(),
      ...overrides,
    },
  )
}

/**
 * PAT-T05 — the immutable clinical history.
 *
 * Oracle (spec): history preserved, a server-side author, exactly one successor, 409 on a
 * concurrent correction, and reception seeing no clinical content.
 */
test.describe('PAT-T05: diagnosis history', () => {
  test('records an entry with a server-assigned author', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      await addDiagnosis(request, actor, created.id, {
        // A client-supplied author must not be honoured; it is on the rejected-field list.
        title: 'Autor serwerowy',
      })

      const entries = await listDiagnoses(request, actor, created.id)
      expect(entries).toHaveLength(1)
      expect(entries[0].authorUserId).toBeTruthy()
      expect(entries[0].status).toBe('active')
      // Resolved to a display name, never shown as a uuid.
      expect(entries[0].author?.name).toBeTruthy()
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('rejects a client-supplied author', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const result = await callApi(request, 'POST', '/api/patient/diagnoses', actor, {
        patientId: created.id,
        title: 'Podszywanie',
        description: 'Próba ustawienia autora.',
        diagnosedOn: today(),
        authorUserId: '99999999-9999-4999-8999-999999999999',
        clientRequestId: newRequestId(),
      })
      // 400, not a silent drop: writing history under someone else's name must be refused loudly.
      expect(result.status).toBe(400)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses a future diagnosis date but accepts a historical one', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)

      const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const rejected = await callApi(request, 'POST', '/api/patient/diagnoses', actor, {
        patientId: created.id,
        title: 'Z przyszłości',
        description: 'Nie powinno przejść.',
        diagnosedOn: future,
        clientRequestId: newRequestId(),
      })
      expect(rejected.status).toBe(422)

      // A historical date is legitimate — entries are usually written up after the session.
      const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      await addDiagnosis(request, actor, created.id, { diagnosedOn: past, title: 'Z przeszłości' })
      const entries = await listDiagnoses(request, actor, created.id)
      expect(entries.some((entry) => entry.diagnosedOn === past)).toBe(true)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('a correction supersedes without destroying the original', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const original = await addDiagnosis(request, actor, created.id, {
        title: 'Pierwotna',
        description: 'Pierwotna treść.',
      })

      const correction = await callApiOk<{ id: string }>(
        request,
        'POST',
        `/api/patient/diagnoses/${encodeURIComponent(original.id)}/correct`,
        actor,
        {
          title: 'Skorygowana',
          description: 'Poprawiona treść.',
          diagnosedOn: today(),
          expectedUpdatedAt: original.updatedAt,
          clientRequestId: newRequestId(),
        },
      )

      const entries = await listDiagnoses(request, actor, created.id)
      const before = entries.find((entry) => entry.id === original.id)!
      const after = entries.find((entry) => entry.id === correction.id)!

      // The original keeps its text — the whole point of correcting rather than editing.
      expect(before.description).toBe('Pierwotna treść.')
      expect(before.status).toBe('superseded')
      expect(before.supersededById).toBe(correction.id)
      expect(after.status).toBe('active')
      expect(after.supersedesId).toBe(original.id)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('refuses correcting a superseded entry, so history cannot fork', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const original = await addDiagnosis(request, actor, created.id)
      await callApiOk(
        request,
        'POST',
        `/api/patient/diagnoses/${encodeURIComponent(original.id)}/correct`,
        actor,
        {
          title: 'Pierwsza korekta',
          description: 'Treść korekty.',
          diagnosedOn: today(),
          expectedUpdatedAt: original.updatedAt,
          clientRequestId: newRequestId(),
        },
      )

      const entries = await listDiagnoses(request, actor, created.id)
      const superseded = entries.find((entry) => entry.id === original.id)!

      const second = await callApi(
        request,
        'POST',
        `/api/patient/diagnoses/${encodeURIComponent(original.id)}/correct`,
        actor,
        {
          title: 'Druga korekta',
          description: 'Druga próba.',
          diagnosedOn: today(),
          expectedUpdatedAt: superseded.updatedAt,
          clientRequestId: newRequestId(),
        },
      )
      // One successor per entry: a second would leave two competing "current" entries.
      expect(second.status).toBe(409)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('voids with a required reason and keeps the text', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const entry = await addDiagnosis(request, actor, created.id, {
        title: 'Do unieważnienia',
        description: 'Treść, która musi zostać.',
      })

      const withoutReason = await callApi(
        request,
        'POST',
        `/api/patient/diagnoses/${encodeURIComponent(entry.id)}/void`,
        actor,
        { expectedUpdatedAt: entry.updatedAt },
      )
      expect(withoutReason.status).toBe(400)

      await callApiOk(
        request,
        'POST',
        `/api/patient/diagnoses/${encodeURIComponent(entry.id)}/void`,
        actor,
        { reason: 'Wpisano omyłkowo', expectedUpdatedAt: entry.updatedAt },
      )

      const entries = await listDiagnoses(request, actor, created.id)
      const voided = entries.find((item) => item.id === entry.id)!
      expect(voided.status).toBe('voided')
      expect(voided.voidReason).toBe('Wpisano omyłkowo')
      // Voiding withdraws an entry; it does not erase it.
      expect(voided.description).toBe('Treść, która musi zostać.')
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('voiding stays available on an archived record', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const entry = await addDiagnosis(request, actor, created.id)

      const record = await requirePatient(request, actor, created.id)
      await callApiOk(
        request,
        'POST',
        `/api/patient/patients/${encodeURIComponent(created.id)}/archive`,
        actor,
        { archived: true, expectedUpdatedAt: record.updatedAt },
      )

      // A new entry is refused...
      const blocked = await callApi(request, 'POST', '/api/patient/diagnoses', actor, {
        patientId: created.id,
        title: 'Nowa',
        description: 'Nie powinna przejść.',
        diagnosedOn: today(),
        clientRequestId: newRequestId(),
      })
      expect(blocked.status).toBe(409)

      // ...but repairing existing history is still permitted.
      const current = (await listDiagnoses(request, actor, created.id)).find((item) => item.id === entry.id)!
      await callApiOk(
        request,
        'POST',
        `/api/patient/diagnoses/${encodeURIComponent(entry.id)}/void`,
        actor,
        { reason: 'Korekta po archiwizacji', expectedUpdatedAt: current.updatedAt },
      )
      const voided = (await listDiagnoses(request, actor, created.id)).find((item) => item.id === entry.id)!
      expect(voided.status).toBe('voided')
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('the general patient read carries no clinical content', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      await addDiagnosis(request, actor, created.id, { title: 'Poufne', description: 'Treść kliniczna.' })

      const list = await callApiOk<{ items: Array<Record<string, unknown>> }>(
        request,
        'GET',
        '/api/patient/patients?pageSize=50',
        actor,
      )
      const serialized = JSON.stringify(list.items)
      // Reception reads the register; it must never carry a diagnosis title or description.
      expect(serialized).not.toContain('Treść kliniczna.')
      expect(serialized).not.toContain('Poufne')
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })

  test('a repeated create with the same request id returns the same entry', async ({ request }) => {
    const actor = await login(request)
    let created: CreatedPatient | null = null
    try {
      created = await createPatient(request, actor)
      const clientRequestId = newRequestId()
      const payload = {
        patientId: created.id,
        title: 'Idempotentna',
        description: 'Jedna treść.',
        diagnosedOn: today(),
        clientRequestId,
      }
      const first = await callApiOk<{ id: string }>(request, 'POST', '/api/patient/diagnoses', actor, payload)
      const retry = await callApiOk<{ id: string }>(request, 'POST', '/api/patient/diagnoses', actor, payload)

      expect(retry.id).toBe(first.id)
      expect(await listDiagnoses(request, actor, created.id)).toHaveLength(1)
    } finally {
      await cleanupPatient(request, actor, created?.id ?? null)
    }
  })
})
