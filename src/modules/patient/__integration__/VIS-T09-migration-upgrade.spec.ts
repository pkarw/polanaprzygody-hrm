import { expect, test } from '@playwright/test'
import { Client } from 'pg'
import { Migration20260930114907_patient as ProjectionMigration } from '../migrations/Migration20260930114907_patient'
import { Migration20260930182624_patient as UpgradeMigration } from '../migrations/Migration20260930182624_patient'
import {
  callApiOk,
  cleanupPatient,
  createPatient,
  login,
  type CreatedPatient,
  type PagedResponse,
  type PatientRecord,
} from './helpers/api'

type MigrationLike = {
  up(): void | Promise<void>
  down(): void | Promise<void>
  reset(): void
  getQueries(): unknown[]
}

type MigrationConstructor = new (driver: never, config: never) => MigrationLike
type PgClient = {
  query(sql: string, values?: unknown[]): Promise<unknown>
}

async function executeMigration(
  db: PgClient,
  MigrationClass: MigrationConstructor,
  direction: 'up' | 'down',
): Promise<void> {
  const migration = new MigrationClass(undefined as never, undefined as never)
  await migration[direction]()
  for (const query of migration.getQueries()) {
    if (typeof query !== 'string') throw new Error('Patient migration emitted a non-SQL query')
    await db.query(query)
  }
}

async function hasLegacyColumn(db: PgClient): Promise<boolean> {
  const result = await db.query(
    `select 1 from information_schema.columns
     where table_schema = current_schema() and table_name = 'patient_patients'
       and column_name = 'legacy_patient_number'`,
  ) as { rowCount: number | null }
  return (result.rowCount ?? 0) > 0
}

async function hasProjection(db: PgClient): Promise<boolean> {
  const result = await db.query(
    `select to_regclass(current_schema() || '.patient_patient_list_projection') as relation`,
  ) as { rows: Array<{ relation: string | null }> }
  return Boolean(result.rows[0]?.relation)
}

const VIS_MAPS = [
  'patient:patient_list_projection',
  'patient:patient_visit',
  'patient:patient_visit_service',
] as const

test.describe('VIS-T09: executable migration and compatibility bridge', () => {
  test('runs projection and upgrade down/up cycles while preserving aliases and maps', async ({ request }) => {
    const databaseUrl = process.env.DATABASE_URL
    expect(databaseUrl, 'DATABASE_URL is required for the migration integration proof').toBeTruthy()
    const actor = await login(request)
    let patient: CreatedPatient | null = null
    const db = new Client({ connectionString: databaseUrl })
    await db.connect()

    try {
      patient = await createPatient(request, actor, {
        firstName: 'Migration',
        lastName: 'Compatibility',
        email: `migration-${crypto.randomUUID()}@example.test`,
      })
      const patientId = patient.id
      const legacyNumber = `P-${patientId}`
      const scopeResult = await db.query(
        'select tenant_id, organization_id from patient_patients where id = $1',
        [patientId],
      ) as { rows: Array<{ tenant_id: string; organization_id: string }> }
      const scope = scopeResult.rows[0]
      expect(scope).toBeTruthy()

      const mapResult = await db.query(
        `select id, entity_id from encryption_maps
         where tenant_id = $1 and organization_id = $2 and deleted_at is null and is_active = true
           and entity_id = any($3::text[])
         order by entity_id`,
        [scope.tenant_id, scope.organization_id, [...VIS_MAPS]],
      ) as { rows: Array<{ id: string; entity_id: string }> }
      expect(mapResult.rows.map((row) => row.entity_id)).toEqual([...VIS_MAPS].sort())
      const preexistingMapIds = mapResult.rows.map((row) => row.id).sort()

      // Execute the actual view migration, not copied SQL, and prove it can be rolled
      // back and re-applied in the disposable integration database.
      await executeMigration(db, ProjectionMigration, 'down')
      expect(await hasProjection(db)).toBe(false)
      await executeMigration(db, ProjectionMigration, 'up')
      expect(await hasProjection(db)).toBe(true)

      // Return to the pre-upgrade shape, create a real preview-era row, then execute the
      // generated upgrade migration exactly as the deploy runner does.
      await executeMigration(db, UpgradeMigration, 'down')
      expect(await hasLegacyColumn(db)).toBe(false)
      await db.query('update patient_patients set patient_number = $1 where id = $2', [legacyNumber, patientId])
      await executeMigration(db, UpgradeMigration, 'up')

      const upgraded = await db.query(
        'select patient_number, legacy_patient_number from patient_patients where id = $1',
        [patientId],
      ) as { rows: Array<{ patient_number: string; legacy_patient_number: string | null }> }
      expect(upgraded.rows[0]?.legacy_patient_number).toBe(legacyNumber)
      expect(upgraded.rows[0]?.patient_number).toMatch(/^P-[0-9a-f-]{36}$/)
      expect(upgraded.rows[0]?.patient_number).not.toBe(legacyNumber)

      for (const query of [
        `patientNumber=${encodeURIComponent(legacyNumber)}`,
        `search=${encodeURIComponent(legacyNumber)}`,
      ]) {
        const result = await callApiOk<PagedResponse<PatientRecord>>(
          request,
          'GET',
          `/api/patient/patients?${query}&pageSize=10`,
          actor,
        )
        expect(result.items?.map((item) => item.id)).toContain(patientId)
        expect(result.items?.find((item) => item.id === patientId)?.patientNumber).not.toBe(legacyNumber)
      }

      // A second rollback restores the legacy number but must not delete maps that
      // existed before this migration. Re-applying returns to the safe canonical form.
      await executeMigration(db, UpgradeMigration, 'down')
      const rolledBack = await db.query(
        'select patient_number from patient_patients where id = $1',
        [patientId],
      ) as { rows: Array<{ patient_number: string }> }
      expect(rolledBack.rows[0]?.patient_number).toBe(legacyNumber)
      const mapsAfterDown = await db.query(
        `select id from encryption_maps
         where tenant_id = $1 and organization_id = $2 and deleted_at is null and is_active = true
           and entity_id = any($3::text[])
         order by id`,
        [scope.tenant_id, scope.organization_id, [...VIS_MAPS]],
      ) as { rows: Array<{ id: string }> }
      expect(mapsAfterDown.rows.map((row) => row.id).sort()).toEqual(preexistingMapIds)

      await executeMigration(db, UpgradeMigration, 'up')
      const reapplied = await db.query(
        'select patient_number, legacy_patient_number from patient_patients where id = $1',
        [patientId],
      ) as { rows: Array<{ patient_number: string; legacy_patient_number: string | null }> }
      expect(reapplied.rows[0]?.legacy_patient_number).toBe(legacyNumber)
      expect(reapplied.rows[0]?.patient_number).not.toBe(legacyNumber)
    } finally {
      // A failed assertion must not strand the shared disposable test database in the
      // rollback shape. Restore both migrations before API cleanup.
      if (!(await hasLegacyColumn(db))) await executeMigration(db, UpgradeMigration, 'up')
      if (!(await hasProjection(db))) await executeMigration(db, ProjectionMigration, 'up')
      await db.end()
      await cleanupPatient(request, actor, patient?.id ?? null)
    }
  })
})
