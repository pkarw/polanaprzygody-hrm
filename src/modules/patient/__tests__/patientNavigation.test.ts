/**
 * Pins the shape of the patient register's sidebar entry.
 *
 * The register used to be a lone top-level "Care" item: create and detail both declared
 * `navHidden`, so an operator standing on `/backend/patient/patients/create` or on a patient
 * card saw nothing selected in the sidebar at all. Dropping the flag from the create page
 * makes `buildAdminNav` nest it under the register, which is also what lights the parent up
 * on the detail route.
 *
 * The assertions run the real `page.meta.ts` exports through the framework's own nav builder
 * rather than restating the metadata, so this fails if either the metadata or the nesting
 * contract moves.
 */
import { describe, expect, it } from '@jest/globals'
import { buildAdminNav } from '@open-mercato/ui/backend/utils/nav'
import { resolvePageRouteMetadata } from '@open-mercato/shared/modules/registry'
import { metadata as listMetadata } from '../backend/patient/patients/page.meta'
import { metadata as createMetadata } from '../backend/patient/patients/create/page.meta'
import { metadata as detailMetadata } from '../backend/patient/patients/[id]/page.meta'

const LIST_HREF = '/backend/patient/patients'
const CREATE_HREF = '/backend/patient/patients/create'
const DETAIL_HREF = '/backend/patient/patients/[id]'

async function buildPatientNav(grantedFeatures: string[]) {
  const modules = [
    {
      id: 'patient',
      backendRoutes: [
        resolvePageRouteMetadata(LIST_HREF, listMetadata),
        resolvePageRouteMetadata(CREATE_HREF, createMetadata),
        resolvePageRouteMetadata(DETAIL_HREF, detailMetadata),
      ],
    },
  ]
  return buildAdminNav(modules as never, { path: LIST_HREF }, [], undefined, {
    checkFeatures: async (required: string[]) =>
      new Set(required.filter((feature) => grantedFeatures.includes(feature))),
  })
}

const ALL_FEATURES = ['patient.patients.view', 'patient.patients.manage']

describe('patient register navigation', () => {
  it('nests the create page under the register instead of listing it separately', async () => {
    const roots = await buildPatientNav(ALL_FEATURES)

    expect(roots.map((item: { href: string }) => item.href)).toEqual([LIST_HREF])
    expect(roots[0].children?.map((child: { href: string }) => child.href)).toEqual([CREATE_HREF])
  })

  it('keeps the dynamic detail route out of navigation', async () => {
    const roots = await buildPatientNav(ALL_FEATURES)
    const hrefs = roots.flatMap((item: { href: string; children?: { href: string }[] }) => [
      item.href,
      ...(item.children ?? []).map((child) => child.href),
    ])

    expect(hrefs).not.toContain(DETAIL_HREF)
  })

  it('hides the create child from a user who may only view patients', async () => {
    const roots = await buildPatientNav(['patient.patients.view'])

    expect(roots.map((item: { href: string }) => item.href)).toEqual([LIST_HREF])
    expect(roots[0].children ?? []).toEqual([])
  })
})
