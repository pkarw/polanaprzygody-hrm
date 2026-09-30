import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { VisitDetailForm } from '../../../../components/VisitForm'

export default async function VisitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <Page><PageBody><VisitDetailForm id={id} /></PageBody></Page>
}
