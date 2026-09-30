"use client"
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ComboboxInput, type ComboboxOption } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import type { PatientListItem, PatientPagedResponse } from '../types'
import { loadTeamMemberOptions, resolveTeamMemberLabel } from './referencePickers'

export function VisitTeamMemberField({
  value,
  onChange,
  patientId,
  disabled = false,
  historicalOption,
}: {
  value: string
  onChange: (value: string) => void
  patientId?: string
  disabled?: boolean
  historicalOption?: ComboboxOption
}) {
  const patientSuggestion = useQuery<PatientPagedResponse<PatientListItem>>({
    queryKey: ['patient.patients', 'visit-owner-suggestion', patientId],
    enabled: Boolean(patientId),
    queryFn: () => fetchCrudList<PatientListItem>('patient/patients', {
      id: patientId,
      pageSize: 1,
    }),
  })
  const owner = patientSuggestion.data?.items?.[0]?.owner
  const seedOptions = React.useMemo<ComboboxOption[]>(() => {
    const options: ComboboxOption[] = []
    if (historicalOption) options.push(historicalOption)
    if (owner?.id && owner.name && !options.some((option) => option.value === owner.id)) {
      options.push({ value: owner.id, label: owner.name })
    }
    return options
  }, [historicalOption, owner?.id, owner?.name])

  return (
    <ComboboxInput
      value={value}
      onChange={onChange}
      seedOptions={seedOptions}
      loadSuggestions={loadTeamMemberOptions}
      resolveLabel={resolveTeamMemberLabel}
      allowCustomValues={false}
      disabled={disabled}
    />
  )
}

export default VisitTeamMemberField
