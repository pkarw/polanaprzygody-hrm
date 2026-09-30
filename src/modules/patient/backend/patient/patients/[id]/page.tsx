import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { PatientDetail } from '../../../../components/PatientDetail'

/**
 * `params` is awaited because Next.js hands dynamic route params to a server component as a
 * promise; reading `params.id` directly would be a synchronous access to an unresolved value.
 */
export default async function PatientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <Page>
      <PageBody>
        <PatientDetail id={id} />
      </PageBody>
    </Page>
  )
}
