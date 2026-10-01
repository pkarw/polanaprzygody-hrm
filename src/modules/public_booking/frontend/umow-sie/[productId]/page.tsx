import { BookingWizard } from '../../components/BookingWizard'

export default function PublicBookingWizardPage({ params }: { params: { productId: string } }) {
  return <BookingWizard productId={params.productId} />
}
