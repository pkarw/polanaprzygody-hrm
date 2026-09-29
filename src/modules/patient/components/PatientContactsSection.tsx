"use client"
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { Alert } from '@open-mercato/ui/primitives/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { CheckboxField } from '@open-mercato/ui/primitives/checkbox-field'
import { Input } from '@open-mercato/ui/primitives/input'
import { FieldLabel, Label } from '@open-mercato/ui/primitives/label'
import { ComboboxInput } from '@open-mercato/ui/backend/inputs/ComboboxInput'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { apiCallOrThrow, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { loadCrmPersonOptions, resolveCrmPersonLabel } from './referencePickers'
import type { PatientContactItem, PatientPagedResponse } from '../types'

/**
 * The patient card's CRM contacts tab.
 *
 * A patient may have zero contacts, the same person may be linked to several patients, and
 * the three roles are independent flags so a guardian can also be the payer. What the UI
 * must prevent is the two shapes the server refuses anyway: no role at all, and a primary
 * contact who is not a contact. Both are disabled in the dialog rather than submitted and
 * rejected, so the operator is not taught by error message.
 *
 * Unlinking removes the LINK. The copy says so explicitly, because "delete contact" next to
 * a person's name reasonably reads as deleting the person — and the spec requires that
 * unlinking never cascade into CRM.
 */
export type PatientContactsSectionProps = {
  patientId: string
  /** An archived record accepts no new links; existing ones stay readable. */
  readOnly?: boolean
  onMutated?: () => void
}

type RoleFlags = {
  isGuardian: boolean
  isContact: boolean
  isPayer: boolean
  isPrimaryContact: boolean
}

type DialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; contact: PatientContactItem }

const EMPTY_ROLES: RoleFlags = {
  isGuardian: false,
  isContact: false,
  isPayer: false,
  isPrimaryContact: false,
}

export function PatientContactsSection({ patientId, readOnly = false, onMutated }: PatientContactsSectionProps) {
  const t = useT()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [dialog, setDialog] = React.useState<DialogState>({ mode: 'closed' })

  const queryKey = React.useMemo(() => ['patient.contacts', patientId], [patientId])

  const { data, isLoading, error, refetch } = useQuery<PatientPagedResponse<PatientContactItem>>({
    queryKey,
    queryFn: async () =>
      readApiResultOrThrow<PatientPagedResponse<PatientContactItem>>(
        `/api/patient/contacts?patientId=${encodeURIComponent(patientId)}&pageSize=100`,
        undefined,
        { errorMessage: t('patient.patients.contacts.error') },
      ) as Promise<PatientPagedResponse<PatientContactItem>>,
  })

  const refresh = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey })
    onMutated?.()
  }, [onMutated, queryClient, queryKey])

  const items = data?.items ?? []

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" aria-live="polite">
        <Spinner className="size-4" />
        {t('patient.common.loading')}
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        title={t('patient.patients.contacts.error')}
        description={error instanceof Error ? error.message : undefined}
        actions={<Button onClick={() => refetch()}>{t('patient.common.retry')}</Button>}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/*
        `SectionHeader` takes `count` and a single `action`, not a description, so the
        explanatory line sits below it. `count` is the number of links, which is useful here
        precisely because zero contacts is a legitimate state rather than a missing step.
      */}
      <div className="space-y-1">
        <SectionHeader
          title={t('patient.patients.tabs.contacts')}
          count={items.length}
          action={
            readOnly ? undefined : (
              <Button onClick={() => setDialog({ mode: 'create' })}>
                {t('patient.patients.contacts.add')}
              </Button>
            )
          }
        />
        <p className="text-sm text-muted-foreground">{t('patient.patients.contacts.description')}</p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={t('patient.patients.contacts.empty.title')}
          description={t('patient.patients.contacts.empty.body')}
          actions={
            readOnly ? undefined : (
              <Button onClick={() => setDialog({ mode: 'create' })}>
                {t('patient.patients.contacts.add')}
              </Button>
            )
          }
        />
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((contact) => (
            <li key={contact.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {contact.person
                      ? contact.person.name
                      : t('patient.patients.contacts.unavailablePerson')}
                  </span>
                  {contact.person && !contact.person.isAvailable ? (
                    <StatusBadge variant="warning" appearance="light">
                      {t('patient.common.unavailableReference')}
                    </StatusBadge>
                  ) : null}
                  {contact.isPrimaryContact ? (
                    <StatusBadge variant="info" appearance="light">
                      {t('patient.patients.contacts.roles.primary')}
                    </StatusBadge>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {contact.isGuardian ? <span>{t('patient.patients.contacts.roles.guardian')}</span> : null}
                  {contact.isContact ? <span>{t('patient.patients.contacts.roles.contact')}</span> : null}
                  {contact.isPayer ? <span>{t('patient.patients.contacts.roles.payer')}</span> : null}
                </div>
                {contact.relationshipLabel ? (
                  <p className="text-sm text-muted-foreground">{contact.relationshipLabel}</p>
                ) : null}
              </div>
              {readOnly ? null : (
                <RowActions
                  items={[
                    {
                      id: 'patient.contacts.edit',
                      label: t('patient.patients.contacts.edit'),
                      onSelect: () => setDialog({ mode: 'edit', contact }),
                    },
                    {
                      id: 'patient.contacts.unlink',
                      label: t('patient.patients.contacts.unlink'),
                      destructive: true,
                      onSelect: async () => {
                        const confirmed = await confirm({
                          title: t('patient.patients.contacts.confirmUnlink.title'),
                          // Names what is and is not removed: the link goes, the CRM record stays.
                          description: t('patient.patients.contacts.confirmUnlink.body'),
                          variant: 'destructive',
                        })
                        if (!confirmed) return
                        try {
                          await withScopedApiRequestHeaders(
                            buildOptimisticLockHeader(contact.updatedAt),
                            () =>
                              apiCallOrThrow('/api/patient/contacts', {
                                method: 'DELETE',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({
                                  id: contact.id,
                                  expectedUpdatedAt: contact.updatedAt,
                                }),
                              }),
                          )
                          flash(t('patient.patients.contacts.flash.unlinked'), 'success')
                          refresh()
                        } catch (err) {
                          if (surfaceRecordConflict(err, t)) {
                            refresh()
                            return
                          }
                          flash(
                            err instanceof Error && err.message
                              ? err.message
                              : t('patient.patients.contacts.error'),
                            'error',
                          )
                        }
                      },
                    },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <ContactDialog
        state={dialog}
        patientId={patientId}
        onClose={() => setDialog({ mode: 'closed' })}
        onSaved={() => {
          setDialog({ mode: 'closed' })
          refresh()
        }}
      />
      {ConfirmDialogElement}
    </div>
  )
}

/**
 * Create / edit dialog for one contact link.
 *
 * The person picker is present only when creating. On edit it is absent by design: the API
 * refuses to re-point a link, because doing so would rewrite who is recorded as this
 * patient's guardian while keeping the link's identity and audit trail. Changing the person
 * is an unlink plus a link, and both are audited.
 */
function ContactDialog({
  state,
  patientId,
  onClose,
  onSaved,
}: {
  state: DialogState
  patientId: string
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const isOpen = state.mode !== 'closed'
  const editing = state.mode === 'edit' ? state.contact : null

  const [personId, setPersonId] = React.useState<string>('')
  const [roles, setRoles] = React.useState<RoleFlags>(EMPTY_ROLES)
  /** Gates the "pick at least one role" message until the operator has engaged with it. */
  const [rolesTouched, setRolesTouched] = React.useState(false)
  const [relationshipLabel, setRelationshipLabel] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  // Reset from the record being edited every time the dialog opens, so a cancelled edit does
  // not leak its values into the next one.
  React.useEffect(() => {
    if (!isOpen) return
    setFormError(null)
    setIsSubmitting(false)
    if (editing) {
      setPersonId(editing.customerEntityId)
      setRolesTouched(true)
      setRoles({
        isGuardian: editing.isGuardian,
        isContact: editing.isContact,
        isPayer: editing.isPayer,
        isPrimaryContact: editing.isPrimaryContact,
      })
      setRelationshipLabel(editing.relationshipLabel ?? '')
    } else {
      setPersonId('')
      setRolesTouched(false)
      setRoles(EMPTY_ROLES)
      setRelationshipLabel('')
    }
  }, [editing, isOpen])

  const hasAnyRole = roles.isGuardian || roles.isContact || roles.isPayer
  const primaryIsConsistent = !roles.isPrimaryContact || roles.isContact
  const canSubmit =
    hasAnyRole && primaryIsConsistent && (editing !== null || personId.length > 0) && !isSubmitting

  const submit = React.useCallback(async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    setFormError(null)
    const label = relationshipLabel.trim()
    try {
      if (editing) {
        await withScopedApiRequestHeaders(buildOptimisticLockHeader(editing.updatedAt), () =>
          apiCallOrThrow('/api/patient/contacts', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: editing.id,
              expectedUpdatedAt: editing.updatedAt,
              ...roles,
              // Explicit null clears the column; an empty string would store a value.
              relationshipLabel: label.length > 0 ? label : null,
            }),
          }),
        )
        flash(t('patient.patients.contacts.flash.saved'), 'success')
      } else {
        await apiCallOrThrow('/api/patient/contacts', {
          // optimistic-lock-exempt: create has no prior version to compare against.
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            patientId,
            customerEntityId: personId,
            ...roles,
            relationshipLabel: label.length > 0 ? label : null,
          }),
        })
        flash(t('patient.patients.contacts.flash.linked'), 'success')
      }
      onSaved()
    } catch (err) {
      if (surfaceRecordConflict(err, t)) {
        onSaved()
        return
      }
      // The error stays in the dialog with the operator's input intact, rather than closing
      // and discarding what they typed.
      setFormError(
        err instanceof Error && err.message ? err.message : t('patient.patients.contacts.error'),
      )
    } finally {
      setIsSubmitting(false)
    }
  }, [canSubmit, editing, onSaved, patientId, personId, relationshipLabel, roles, t])

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        // Cmd/Ctrl+Enter submits; Escape is handled by the dialog primitive.
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t('patient.patients.contacts.edit')
              : t('patient.patients.contacts.add')}
          </DialogTitle>
          <DialogDescription>{t('patient.patients.contacts.dialogHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {formError ? <Alert variant="destructive">{formError}</Alert> : null}

          {editing ? (
            <div className="space-y-1">
              <Label>{t('patient.patients.contacts.person')}</Label>
              <p className="text-sm">
                {editing.person ? editing.person.name : t('patient.patients.contacts.unavailablePerson')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('patient.patients.contacts.personImmutableHint')}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <FieldLabel required>{t('patient.patients.contacts.person')}</FieldLabel>
              {/*
                One searchable combobox, the same control the create form uses for guardians.
                A separate search box above a select made the operator type in one field and
                choose in another for a single value. The submitted value is still the CRM
                entity id and `allowCustomValues` stays off, so the operator never types or
                reads a uuid and never submits free text the server would reject.

                An operator without `customers.people.view` gets an empty option list — the
                picker inherits the customers module's ACL, so that is the correct fail-closed
                outcome, and the submit guard keeps the form unsubmittable.
              */}
              <ComboboxInput
                value={personId}
                onChange={(next: string | null) => setPersonId(next ?? '')}
                placeholder={t('patient.patients.contacts.selectPerson')}
                loadSuggestions={loadCrmPersonOptions}
                // Renders an already-chosen person by name on re-open rather than leaving the
                // control looking empty until it is searched again.
                resolveLabel={resolveCrmPersonLabel}
                allowCustomValues={false}
                clearable
                clearLabel={t('patient.patients.contacts.clearPerson')}
              />
            </div>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('patient.patients.contacts.roles.legend')}</legend>
            <CheckboxField
              label={t('patient.patients.contacts.roles.guardian')}
              checked={roles.isGuardian}
              onCheckedChange={(checked) => {
                setRolesTouched(true)
                setRoles((prev) => ({ ...prev, isGuardian: checked === true }))
              }}
            />
            <CheckboxField
              label={t('patient.patients.contacts.roles.contact')}
              checked={roles.isContact}
              onCheckedChange={(checked) => {
                setRolesTouched(true)
                setRoles((prev) => ({
                  ...prev,
                  isContact: checked === true,
                  // Clearing "contact" cannot leave "primary contact" set — the table's own
                  // check constraint forbids it, so the UI keeps the pair coherent instead of
                  // letting the operator build a payload the server will reject.
                  isPrimaryContact: checked === true ? prev.isPrimaryContact : false,
                }))
              }}
            />
            <CheckboxField
              label={t('patient.patients.contacts.roles.payer')}
              checked={roles.isPayer}
              onCheckedChange={(checked) => {
                setRolesTouched(true)
                setRoles((prev) => ({ ...prev, isPayer: checked === true }))
              }}
            />
            <CheckboxField
              label={t('patient.patients.contacts.roles.primary')}
              description={t('patient.patients.contacts.roles.primaryHint')}
              checked={roles.isPrimaryContact}
              disabled={!roles.isContact}
              onCheckedChange={(checked) => {
                setRolesTouched(true)
                setRoles((prev) => ({ ...prev, isPrimaryContact: checked === true }))
              }}
            />
            {/* Only after the operator has touched the roles or tried to save. Rendering it on
                open greets a freshly opened dialog with an error about something nobody has
                had the chance to get wrong yet. */}
            {!hasAnyRole && rolesTouched ? (
              <p className="text-xs text-destructive" role="alert">
                {t('patient.patients.contacts.roles.atLeastOne')}
              </p>
            ) : null}
          </fieldset>

          <div className="space-y-1">
            <Label htmlFor="patient-contact-relationship">
              {t('patient.patients.contacts.relationshipLabel')}
            </Label>
            <Input
              id="patient-contact-relationship"
              value={relationshipLabel}
              maxLength={120}
              onChange={(event) => setRelationshipLabel(event.target.value)}
              placeholder={t('patient.patients.contacts.relationshipPlaceholder')}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('patient.common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {t('patient.patients.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default PatientContactsSection
