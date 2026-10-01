import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'

/**
 * Regression oracle for the query engine's entity-id → table-name resolution.
 *
 * The failure this pins was real: `GET /api/patient/patients` returned
 * `relation "patients" does not exist`. The engine resolves a table in three steps:
 *
 * 1. Look up the entity CLASS by the PascalCase of the entity-id segment. MikroORM's
 *    `MetadataStorage.find` falls back to a map keyed on the real CLASS NAME, so
 *    `patient:patient_address` → `PatientAddress` hits, even though the generator registers the
 *    entity under `patient.PatientAddress`.
 * 2. Otherwise scan all metadata for a table named `<module>_<segment>`, `<pluralized segment>`
 *    or `<module>_<pluralized segment>`.
 * 3. Otherwise fall back to the pluralized segment alone.
 *
 * **Step 2 never matches on this framework version.** `engine.ts` does
 * `const allMeta: any[] = metadata.getAll?.() ?? []` and iterates it, but `getAll()` returns
 * MikroORM's `#metadataMap`, which is a `Map`. Iterating a `Map` yields `[key, value]` pairs, so
 * `meta?.tableName` is always `undefined` and the scan can never hit. (Reported upstream; the same
 * package already ships a correct normalizer in `lib/db/entityMetadata.ts` that the engine does
 * not use.)
 *
 * So step 1 is the ONLY working path, for every entity — not merely for the awkward ones. That
 * makes the class names load-bearing: `toPascalCase(segment) === className` is the single
 * invariant keeping any of these tables reachable, and this suite pins it. A class rename that
 * breaks it sends reads to a table that does not exist, exactly as the outage did.
 *
 * The pluralizer compounds it. It returns a name ending in `s` UNCHANGED, so even if step 2 were
 * repaired, `patient_address` and `patient_diagnosis` would still never become
 * `patient_addresses` / `patient_diagnoses`.
 *
 * The outage itself was not a naming defect: the metadata was simply absent from a dev server
 * bootstrapped before `yarn generate` registered the module and before the migration ran, so
 * every step missed and the fallback produced `patients`. The engine caches a resolution per
 * entity id for the process lifetime, which is why restarting the server — not retrying the
 * request — is what clears it.
 *
 * The suite reads the entity source rather than ORM metadata because the query engine pulls in
 * ESM the unit runner cannot load, and because the declaration is what a future edit changes.
 */

const ENTITIES_SOURCE = readFileSync(
  path.join(__dirname, '..', 'data', 'entities.ts'),
  'utf8',
)

/** The engine's own pluralizer, reproduced so the expectation is derived, not restated. */
function pluralizeBaseName(name: string): string {
  if (!name) return name
  if (name.endsWith('s')) return name
  if (name.endsWith('y')) return `${name.slice(0, -1)}ies`
  return `${name}s`
}

/** The engine's own PascalCase helper, reproduced so the expectation is derived, not restated. */
function toPascalCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('')
}

/** `PatientContactLink` → `patient_contact_link`, matching how entity ids are generated. */
function toEntitySegment(className: string): string {
  return className
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

/** Every `@Entity({ tableName: 'x' })` paired with the class it decorates. */
function readDeclaredEntities(): Array<{ className: string; tableName: string }> {
  const found: Array<{ className: string; tableName: string }> = []
  const pattern = /@Entity\(\{\s*tableName:\s*'([a-z0-9_]+)'\s*\}\)([\s\S]*?)export class (\w+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(ENTITIES_SOURCE)) !== null) {
    found.push({ tableName: match[1], className: match[3] })
  }
  return found
}

describe('patient entity table naming', () => {
  const declared = readDeclaredEntities()

  it('declares the PAT, VIS, and durable delivery tables', () => {
    expect(declared.map((entry) => entry.tableName).sort()).toEqual([
      'patient_addresses',
      'patient_attachment_links',
      'patient_contact_links',
      'patient_diagnoses',
      'patient_document_links',
      'patient_patients',
      'patient_visit_payment_email_deliveries',
      'patient_visit_services',
      'patient_visits',
    ])
  })

  /**
   * The invariant every entity's resolution actually rests on.
   *
   * Step 1 looks the class up by the PascalCase of the entity-id segment. If a class is renamed so
   * that round trip stops holding, the lookup misses and the read falls through to a table name
   * that may not exist.
   */
  it.each(readDeclaredEntities())(
    '$className round-trips through its entity-id segment',
    ({ className }) => {
      expect(toPascalCase(toEntitySegment(className))).toBe(className)
    },
  )

  /**
   * How much protection would remain if the class-name lookup ever stopped working.
   *
   * The honest answer on this version is none, because the table-name scan is dead code. But even
   * once that is repaired upstream, two of these tables still could not be found by scanning: the
   * pluralizer leaves a name ending in `s` untouched, so `patient_address` and `patient_diagnosis`
   * never become their real tables. Recording which entities are in that group means a future
   * rename that moves another one into it is a visible, deliberate change.
   */
  it('records which tables a repaired table-name scan still could not find', () => {
    const scanCandidates = (className: string) => {
      const segment = toEntitySegment(className)
      return [`patient_${segment}`, pluralizeBaseName(segment), `patient_${pluralizeBaseName(segment)}`]
    }
    const unscannable = declared
      .filter((entry) => !scanCandidates(entry.className).includes(entry.tableName))
      .map((entry) => entry.className)
      .sort()
    expect(unscannable).toEqual(['PatientAddress', 'PatientDiagnosis'])

    // `patient_patients` is at least among the candidates a repaired scan would try.
    const patient = declared.find((entry) => entry.className === 'Patient')
    expect(patient?.tableName).toBe('patient_patients')
    expect(scanCandidates('Patient')).toContain('patient_patients')
    // The exact value the dev server fell back to while the module was unregistered.
    expect(patient?.tableName).not.toBe('patients')
  })

  it('derives the entity segments the encryption map and routes spell out as literals', () => {
    const segments = declared.map((entry) => `patient:${toEntitySegment(entry.className)}`).sort()
    expect(segments).toEqual([
      'patient:patient',
      'patient:patient_address',
      'patient:patient_attachment_link',
      'patient:patient_contact_link',
      'patient:patient_diagnosis',
      'patient:patient_document_link',
      'patient:patient_visit',
      'patient:patient_visit_payment_email_delivery',
      'patient:patient_visit_service',
    ])
  })
})
