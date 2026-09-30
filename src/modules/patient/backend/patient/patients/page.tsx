import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import PatientsTable from '../../../components/PatientsTable'

export default function PatientsListPage() {
  return (
    <Page>
      <PageBody>
        <PatientsTable />
      </PageBody>
    </Page>
  )
}
