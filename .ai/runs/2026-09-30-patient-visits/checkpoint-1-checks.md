# Checkpoint 1 — VIS-1 planning and services

**Recorded:** 2026-09-30T13:01:17Z  
**Branch:** `feat/patient-visits`  
**Last implementation commit:** `0ac0107`

## Outcome

VIS-1 is implemented through the aggregate, scoped commands, CRUD/OpenAPI routes,
patient projection, and staff UI. The local browser preview rendered every planned
surface without page errors. Browser fixtures were synthetic and route-intercepted
because the installed local database predates the new visit tables; no migration was
applied to a user database.

The repository-native ephemeral integration environment remains blocked before test
execution because Docker CLI is not installed. This does not block continued
development, but VIS-1 stays `in_progress` in the source spec until its real-database
integration gate can run.

## Targeted validation

| Check | Result | Evidence |
|---|---|---|
| `yarn generate` | pass | 432 paths; outputs current after visit form entity correction |
| `yarn typecheck` | pass | TypeScript completed with no diagnostics |
| `yarn lint` | pass | 0 errors; 8 pre-existing unrelated warnings |
| `yarn ds:check` | pass | 312 files passed |
| `yarn test src/modules/patient/__tests__ --runInBand` | pass | 16 suites, 205 tests |
| `yarn test src/modules/patient/__tests__/visitUiContracts.test.ts --runInBand` | pass | 1 suite, 5 tests after checkpoint fix |
| `yarn test:integration --list VIS-T01` | pass | 2 Playwright cases discovered and compiled |
| `yarn test:integration:ephemeral VIS-T --screenshots` | environment-blocked | Docker CLI is not available in `PATH`; runner stopped before provisioning or executing tests |
| `git diff --check` | pass | no whitespace errors |

## Browser preview

- App: branch dev server at `http://127.0.0.1:3100`.
- Authentication: a locally signed session-bound token for an existing local session;
  no credential or token value was recorded.
- Data: route-intercepted visit, patient, staff, resource, and catalog responses with
  synthetic names only; this verifies the authored UI shell/states, not persistence.
- Result: list, create, detail, dark theme, and 360 px patient-card views rendered;
  there were no browser page errors.
- Runtime probe after the checkpoint correction requested custom-field definitions
  with `entityId=patient:patient_visit`, confirming the canonical form binding.
- Accessibility smoke: semantic headings/forms were reachable and the narrow patient
  surface retained its primary action and horizontally scrollable table.

## Screenshot evidence

| Artifact | Surface | Dimensions |
|---|---|---|
| `checkpoint-1-artifacts/vis-1-list-light.png` | visits list, light theme | 1440×1001 |
| `checkpoint-1-artifacts/vis-1-create-light.png` | schedule form, light theme | 1440×1061 |
| `checkpoint-1-artifacts/vis-1-detail-dark.png` | editable detail, dark theme | 1440×1099 |
| `checkpoint-1-artifacts/vis-1-patient-tab-360.png` | patient visits surface, narrow viewport | 360×901 |

## Migration safety

`Migration20260930114907_patient.ts` and the ORM snapshot were generated and reviewed.
No migration was applied. The checkpoint did not mutate the existing local schema.

## Next

Continue at Step 2.1. Before final completion, run the full real-database integration
suite in the supported ephemeral environment (or obtain explicit approval for a
separate disposable database target).
