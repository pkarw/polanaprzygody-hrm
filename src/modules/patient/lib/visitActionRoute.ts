import { NextResponse } from 'next/server'
import type { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { PatientVisit } from '../data/entities'
import type { VisitPaymentActionResult } from '../commands/visits'
import { requireActorUserId, requirePatientScope, toIsoTimestamp } from './commandSupport'
import {
  attachOperationMetadata,
  buildPatientRouteContext,
  toPatientErrorResponse,
} from './routeSupport'
import '../commands/visits'

type VisitActionPayload = Record<string, unknown> & { expectedUpdatedAt: string }

type VisitActionRouteOptions<TPayload extends VisitActionPayload> = {
  schema: z.ZodType<TPayload>
  commandId(payload: TPayload): string
  commandInput(payload: TPayload, visitId: string, req: Request): Record<string, unknown>
  errorContext: string
  paymentResult?: boolean
}

function requiredTimestamp(value: unknown, field: string): string {
  const timestamp = toIsoTimestamp(value)
  if (!timestamp) throw new Error(`[internal] Stored visit ${field} is invalid`)
  return timestamp
}

/**
 * Shared security pipeline for all visit action endpoints.
 *
 * The body is parsed before guards and parsed again after every guard modification.
 * The record id remains a trusted path value, while tenant/organization/actor always
 * come from the authenticated command context.
 */
export async function runVisitActionRoute<TPayload extends VisitActionPayload>(
  req: Request,
  routeCtx: { params: { id: string } | Promise<{ id: string }> },
  options: VisitActionRouteOptions<TPayload>,
): Promise<Response> {
  let translateFn: (key: string, fallback?: string) => string = (_key, fallback) => fallback ?? ''
  try {
    const { ctx, translate } = await buildPatientRouteContext(req)
    translateFn = translate
    const params = await routeCtx.params
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const parsed = options.schema.parse(body)
    const scope = requirePatientScope(ctx)
    const actorUserId = requireActorUserId(ctx)

    const guard = await runRouteMutationGuards({
      container: ctx.container,
      req,
      auth: {
        userId: actorUserId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      },
      input: {
        resourceKind: 'patient.visit',
        resourceId: params.id,
        operation: 'custom',
        mutationPayload: parsed,
      },
    })
    if (!guard.ok) return guard.response

    const guardedPayload = options.schema.parse({
      ...parsed,
      ...(guard.modifiedPayload ?? {}),
    })
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result, logEntry } = await commandBus.execute<
      Record<string, unknown>,
      PatientVisit | VisitPaymentActionResult
    >(
      options.commandId(guardedPayload),
      { input: options.commandInput(guardedPayload, params.id, req), ctx },
    )
    const paymentResult = options.paymentResult
      ? result as VisitPaymentActionResult
      : null
    const visit = paymentResult?.visit ?? result as PatientVisit

    const response = NextResponse.json(
      {
        ok: true as const,
        id: String(visit.id),
        status: visit.status,
        confirmedAt: toIsoTimestamp(visit.confirmedAt),
        isConfirmed: Boolean(visit.confirmedAt),
        confirmationApplicable: visit.status === 'planned',
        isSettled: Boolean(visit.isSettled),
        settledAt: toIsoTimestamp(visit.settledAt),
        updatedAt: requiredTimestamp(visit.updatedAt, 'updatedAt'),
        ...(paymentResult
          ? {
              paymentLink: paymentResult.paymentLink,
              paymentLinkError: paymentResult.paymentLinkError,
              ...(paymentResult.paymentLinkEmailQueued === undefined
                ? {}
                : { paymentLinkEmailQueued: paymentResult.paymentLinkEmailQueued }),
              ...(paymentResult.paymentLinkEmailError === undefined
                ? {}
                : { paymentLinkEmailError: paymentResult.paymentLinkEmailError }),
            }
          : {}),
      },
      { status: 200 },
    )
    await guard.runAfterSuccess()
    return attachOperationMetadata(response, logEntry, 'patient.patient_visit')
  } catch (err) {
    return toPatientErrorResponse(err, translateFn, options.errorContext)
  }
}
