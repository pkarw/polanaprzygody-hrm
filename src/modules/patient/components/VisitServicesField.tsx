"use client"
import * as React from 'react'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { ComboboxInput, type ComboboxOption } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  loadProductOptions,
  resolveProductAvailability,
  resolveProductLabel,
} from './referencePickers'

export type VisitServiceSeed = { productId: string; title: string; sku: string | null }

export function VisitServicesField({
  value,
  onChange,
  disabled = false,
  seedServices = [],
}: {
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  seedServices?: VisitServiceSeed[]
}) {
  const t = useT()
  const [candidate, setCandidate] = React.useState('')
  const seedOptions = React.useMemo<ComboboxOption[]>(
    () => seedServices.map((service) => ({
      value: service.productId,
      label: service.sku ? `${service.title} — ${service.sku}` : service.title,
    })),
    [seedServices],
  )
  const [labels, setLabels] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(seedOptions.map((option) => [option.value, option.label])),
  )
  const [availability, setAvailability] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    let cancelled = false
    void Promise.all(value.filter((id) => !labels[id]).map(async (id) => [id, await resolveProductLabel(id)] as const))
      .then((entries) => {
        if (!cancelled && entries.length > 0) {
          setLabels((current) => ({ ...current, ...Object.fromEntries(entries) }))
        }
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [labels, value])

  React.useEffect(() => {
    let cancelled = false
    const unchecked = value.filter((id) => availability[id] === undefined)
    void Promise.all(unchecked.map(async (id) => [id, await resolveProductAvailability(id)] as const))
      .then((entries) => {
        if (!cancelled && entries.length > 0) {
          setAvailability((current) => ({ ...current, ...Object.fromEntries(entries) }))
        }
      })
    return () => { cancelled = true }
  }, [availability, value])

  const addCandidate = React.useCallback(() => {
    if (!candidate || value.includes(candidate)) return
    void resolveProductLabel(candidate).then((label) => {
      setLabels((current) => ({ ...current, [candidate]: label }))
    }).catch(() => undefined)
    onChange([...value, candidate])
    setAvailability((current) => ({ ...current, [candidate]: true }))
    setCandidate('')
  }, [candidate, onChange, value])

  const move = React.useCallback((index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= value.length) return
    const next = [...value]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }, [onChange, value])

  return (
    <div className="space-y-3">
      {!disabled ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <ComboboxInput
              value={candidate}
              onChange={setCandidate}
              seedOptions={seedOptions}
              loadSuggestions={loadProductOptions}
              resolveLabel={resolveProductLabel}
              allowCustomValues={false}
              placeholder={t('patient.visits.services.search')}
            />
          </div>
          <Button type="button" variant="outline" onClick={addCandidate} disabled={!candidate || value.includes(candidate)}>
            {t('patient.visits.services.add')}
          </Button>
        </div>
      ) : null}

      {value.length === 0 ? (
        <EmptyState
          title={t('patient.visits.services.empty.title')}
          description={t('patient.visits.services.empty.body')}
        />
      ) : (
        <ol className="space-y-2" aria-label={t('patient.visits.services.label')}>
          {value.map((productId, index) => (
            <li key={productId} className="flex items-center gap-2 rounded-md border bg-card p-3">
              <span className="min-w-0 flex-1 truncate">
                {labels[productId] ?? t('patient.common.loading')}
                {availability[productId] === false ? (
                  <span className="ml-1 text-muted-foreground">
                    ({t('patient.common.unavailableReference')})
                  </span>
                ) : null}
              </span>
              {!disabled ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={t('patient.visits.services.moveUp', { name: labels[productId] ?? '' })}
                  >
                    <ArrowUp aria-hidden="true" className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => move(index, 1)}
                    disabled={index === value.length - 1}
                    aria-label={t('patient.visits.services.moveDown', { name: labels[productId] ?? '' })}
                  >
                    <ArrowDown aria-hidden="true" className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => onChange(value.filter((id) => id !== productId))}
                    aria-label={t('patient.visits.services.remove', { name: labels[productId] ?? '' })}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
