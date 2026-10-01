import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'

const read = (...segments: string[]) => readFileSync(path.join(__dirname, '..', ...segments), 'utf8')
const routeHelper = read('lib', 'visitActionRoute.ts')
const routeSupport = read('lib', 'routeSupport.ts')
const confirmationRoute = read('api', 'visits', '[id]', 'confirmation', 'route.ts')
const statusRoute = read('api', 'visits', '[id]', 'status', 'route.ts')
const settlementRoute = read('api', 'visits', '[id]', 'settlement', 'route.ts')

describe('patient visit action route contracts', () => {
  it('publishes per-method auth and the conditional reopen ACL at command level', () => {
    for (const source of [confirmationRoute, statusRoute]) {
      expect(source).toContain("requireFeatures: ['patient.visits.manage']")
    }
    expect(settlementRoute).toContain("requireFeatures: ['patient.visits.settle']")
    expect(statusRoute).toContain('patient.visits.correct')
  })

  it('declares request, success, and complete write-error OpenAPI contracts', () => {
    for (const source of [confirmationRoute, statusRoute, settlementRoute]) {
      expect(source).toContain('requestBody: {')
      expect(source).toContain('patientVisitLifecycleResultSchema')
      expect(source).toContain('...patientWriteErrors')
    }
  })

  it('runs all mutation guards with the CRUD resource kind and reparses modifications', () => {
    expect(routeHelper).toContain('runRouteMutationGuards({')
    expect(routeHelper).toContain("resourceKind: 'patient.visit'")
    expect(routeHelper).toContain("operation: 'custom'")
    const firstParse = routeHelper.indexOf('const parsed = options.schema.parse(body)')
    const guardCall = routeHelper.indexOf('runRouteMutationGuards({')
    const secondParse = routeHelper.indexOf('const guardedPayload = options.schema.parse({')
    const command = routeHelper.indexOf('commandBus.execute<')
    const afterSuccess = routeHelper.indexOf('await guard.runAfterSuccess()')
    expect(firstParse).toBeGreaterThan(-1)
    expect(guardCall).toBeGreaterThan(firstParse)
    expect(secondParse).toBeGreaterThan(guardCall)
    expect(command).toBeGreaterThan(secondParse)
    expect(afterSuccess).toBeGreaterThan(command)
    expect(routeHelper).toContain('const { result, logEntry } = await commandBus.execute')
  })

  it('selects exact commands from validated intent and maps Zod failures to 400', () => {
    expect(confirmationRoute).toContain("payload.confirmed ? 'patient.visits.confirm' : 'patient.visits.unconfirm'")
    expect(statusRoute).toContain("commandId: () => 'patient.visits.transition'")
    expect(settlementRoute).toContain("payload.isSettled ? 'patient.visits.settle' : 'patient.visits.unsettle'")
    expect(routeSupport).toContain('err instanceof ZodError')
    expect(routeSupport).toContain('{ status: 400 }')
  })
})
