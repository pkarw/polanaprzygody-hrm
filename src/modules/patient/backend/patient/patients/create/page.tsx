import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { PatientCreateForm } from '../../../../components/PatientForm'

export default function CreatePatientPage() {
  return (
    <Page>
      <PageBody>
        <PatientCreateForm />
      </PageBody>
    </Page>
  )
}
