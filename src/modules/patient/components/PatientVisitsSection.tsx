"use client"
import { VisitsTable } from './VisitsTable'

export function PatientVisitsSection({ patientId, readOnly }: { patientId: string; readOnly: boolean }) {
  return <VisitsTable patientId={patientId} readOnly={readOnly} embedded />
}

export default PatientVisitsSection
