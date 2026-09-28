import { describe, expect, it, jest } from '@jest/globals'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { POLANA_THERAPISTS } from '../lib/therapistFixtures'
import { writeTherapistCustomFields } from '../lib/staffBootstrap'

describe('Polana staff custom fields', () => {
  it('writes the complete profile through DataEngine and requests standard reindex notification', async () => {
    const setCustomFields = jest.fn(async (_options: Parameters<DataEngine['setCustomFields']>[0]) => {})
    const fixture = POLANA_THERAPISTS[0]

    await writeTherapistCustomFields(
      { setCustomFields },
      { tenantId: 'tenant-1', organizationId: 'organization-1' },
      'member-1',
      fixture,
    )

    expect(setCustomFields).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 'staff:staff_team_member',
      recordId: 'member-1',
      tenantId: 'tenant-1',
      organizationId: 'organization-1',
      notify: true,
      values: expect.objectContaining({
        polana_source_id: fixture.sourceId,
        polana_experience: fixture.experience,
        polana_full_bio: fixture.fullDescription,
        polana_specializations: [...fixture.specializations],
      }),
    }))
  })
})
