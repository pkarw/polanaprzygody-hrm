# Execution plan — patient visits

**Mode:** spec-implementation
**Branch:** `feat/patient-visits`
**Source spec:** `.ai/specs/2026-09-29-patient-visits.md`

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids and `Exec` cells are immutable once the plan is committed — per-Step commits touch only `Status` and `Commit`.

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 0 | 0.1 | Approve VIS readiness and initialize implementation status | inline | done | 5eef61f |
| 1 | 1.1 | Add visit aggregate schema, validation, ACL, encryption, events, and migration | inline | done | 83930cc |
| 1 | 1.2 | Implement scoped visit CRUD commands and patient archive invariant | inline | done | 5ba3efc |
| 1 | 1.3 | Expose visit CRUD API, OpenAPI, and next-visit projection | inline | done | 358afd2 |
| 1 | 1.4 | Deliver VIS-1 list, forms, patient surfaces, translations, and focused tests | inline | done | 912756e |
| 1 | 1.5 | Align the visit form entity contract found during browser verification | inline | done | c400204 |
| 2 | 2.1 | Implement confirmation, lifecycle, and settlement commands | inline | done | 845aac7 |
| 2 | 2.2 | Expose guarded lifecycle action routes and integration coverage | inline | done | 68f7ee4 |
| 2 | 2.3 | Deliver lifecycle dialogs, read-only states, and settlement UI | inline | done | 5cf8ab3 |
| 2 | 2.4 | Complete VIS acceptance, concurrency, security, and browser coverage | inline | done | 1ad6de4 |
| 2 | 2.5 | Preserve timestamp precision and align persisted update assertions | inline | done | 6679eeb |
| 2 | 2.6 | Fix browser-found accessibility, identity privacy, and deterministic UI coverage | inline | done | 339bdbc |
| 2 | 2.7 | Resolve latest-main review conflict and import the VCAL source spec | inline | done | 087835b |

## Goal

Deliver the complete VIS specification so staff can create, edit, confirm, close, reopen, and manually settle scoped patient visits with zero or more catalog services, then prove both implementation phases in a local browser and publish screenshot evidence on GitHub.

## Scope

- Implement VIS-1 and VIS-2 in the existing `src/modules/patient/` module.
- Add the `patient:patient_visit` and `patient:patient_visit_service` additive contracts, commands, routes, events, ACL, migration, and encrypted snapshots.
- Add `/backend/patient/visits`, create/detail flows, patient-card visits access, and the patients-list `nextVisit` projection.
- Cover VIS-AC01..VIS-AC06 through unit/integration/browser validation with self-contained fixtures.
- Run a browser checkpoint with screenshots after each spec phase; attach the images to the draft PR through the tracker evidence operation.

## Non-goals

- No billing, invoices, prices, payments, resource reservation, availability engine, recurring visits, reminders, portal, drag-and-drop calendar, or attachment changes.
- No new npm dependencies and no edits to installed/generated framework files.
- No database migration is applied to a user database; schema generation is a reviewed probe only.
- No changes to installed `catalog`, `staff`, or `resources` contracts.

## Ownership and extension decisions

- `extension-mechanism`: the `patient` module owns the visit aggregate; installed catalog/staff/resources records are referenced by trusted scoped scalar IDs plus encrypted display snapshots and existing option APIs. No installed host mutation is introduced.
- `additive-before-replacement`: new patient routes/pages/hosts and additive patient-card/list behavior are used; no component, route, or module replacement is needed.
- `extension-entity`: rejected because visits are first-class patient aggregates in the same app-owned module, not auxiliary rows extending an installed host entity.
- `eject-last`: rejected; existing public APIs, command primitives, UI components, and generated facts are sufficient.

## Implementation Plan

### Phase 0 — Readiness

#### Step 0.1 — Approve VIS readiness and initialize implementation status

- Record the user's full-spec implementation approval, change the VIS document from Draft to Ready for implementation, and add the phase ledger.
- Preserve the approved scope and note PAT-1 as verified from `.ai/specs/2026-09-29-patient-ehr-base.md` and the existing runtime module.
- Oracle: the readiness audit has no unresolved question and names VIS-1 as the only in-progress phase.

### Phase 1 — VIS-1 planning and services

#### Step 1.1 — Add visit aggregate schema, validation, ACL, encryption, events, and migration

- Extend `src/modules/patient/data/entities.ts` and validators with visit/service contracts, indexes, checks, timestamps, and clear/null semantics.
- Add stable ACL/setup features, encryption maps, response types, and typed additive event IDs.
- Run `yarn generate` and `yarn db:generate`; review and retain only scoped patient visit SQL/snapshot changes, without applying the migration.
- Add focused unit tests for schemas, metadata invariants, and encrypted-field declarations.

#### Step 1.2 — Implement scoped visit CRUD commands and patient archive invariant

- Add bounded patient/visit row locks, trusted tenant+organization scope, active scoped reference resolution, idempotent create, atomic service synchronization, optimistic locking, audit/undo, and post-commit effects.
- Update patient archive/delete behavior to reject active planned visits while preserving lock order `patient → visit`.
- Add focused command tests for zero/one/many services, clearing, retry, rollback, stale versions, cross-scope denial, and lock-timeout mapping.

#### Step 1.3 — Expose visit CRUD API, OpenAPI, and next-visit projection

- Add per-method metadata/OpenAPI CRUD handlers for visits using registered commands and stable response shapes.
- Implement scoped filtered list/detail responses and batched `nextVisit` projection for the visible patient page, omitted without `patient.visits.view`.
- Reuse existing patient/staff/resources/catalog option APIs and verify their exact installed payload fields before wiring.
- Add route tests for validation, ACL/wildcards, scope isolation, pagination, filters, snapshots, and the one-query projection contract.

#### Step 1.4 — Deliver VIS-1 list, forms, patient surfaces, translations, and focused tests

- Add the visits list, create, and editable planned-visit detail using Page/DataTable/CrudForm/shared API helpers and stable host IDs.
- Add service ordering/picker UX, patient-card visits entry, and patients-list next-visit column with required loading/empty/error/validation/conflict/success states.
- Add Polish/English copy, semantic status badges, responsive 360 px layout, keyboard/a11y handling, and focused component/integration tests.
- Phase checkpoint: start the local ephemeral preview, exercise VIS-1 in a browser, capture screenshots for list/create/detail/patient surfaces in light/dark and narrow layout, and attach them to the PR.

#### Step 1.5 — Align the visit form entity contract found during browser verification

- Preserve the published `crud-form:patient.visit` extension slot while binding the form to the aggregate's canonical `patient:patient_visit` entity identifier.
- Keep the regression assertion beside the extension-host contract and regenerate discovery outputs before closing the Phase 1 checkpoint.

### Phase 2 — VIS-2 lifecycle and settlement

#### Step 2.1 — Implement confirmation, lifecycle, and settlement commands

- Add confirm/unconfirm, complete/cancel/no-show/reopen, settle/unsettle state transitions using the aggregate lock/version.
- Enforce separate feature gates, reason/time rules, confirmation reset, protected audit snapshots, and no financial/resource side effects.
- Add command tests for the transition matrix, stale versions, actor/timestamps, forbidden fields, and undo/retry safety.

#### Step 2.2 — Expose guarded lifecycle action routes and integration coverage

- Add confirmation/status/settlement routes with per-method metadata, OpenAPI, mutation guards, revalidation after payload modification, and shared error mapping.
- Add VIS-T04..T07/T09 API integration coverage, including DST offset rules, two-scope denial, concurrent tabs, retry, and patient archive/create races.

#### Step 2.3 — Deliver lifecycle dialogs, read-only states, and settlement UI

- Add guarded action controls/dialogs, required reason flows, confirmation-reset warnings, read-only closed-state behavior, and manual-settlement permission states.
- Preserve input/focus across 409/422, support Escape and Ctrl/Cmd+Enter, announce results, and match M05/M06/M08/M09/M10/M11/M13/M14.
- Add focused component/browser assertions for allowed/denied/wildcard users and narrow/light/dark states.

#### Step 2.4 — Complete VIS acceptance, concurrency, security, and browser coverage

- Complete self-contained VIS-T01..VIS-T09 coverage and PAT regression for the archive invariant, including logging/event privacy checks and missing optional-host behavior.
- Run the Phase 2 local-browser checkpoint against real API fixtures and capture/attach list/detail/action/conflict/read-only/360 px/light/dark screenshots.
- Reconcile VIS-AC01..VIS-AC06 and mark both phases verified only after their exit gates pass.

#### Step 2.6 — Fix browser-found accessibility, identity privacy, and deterministic UI coverage

- Replace inaccessible built-in text/date controls on the patient and visit forms with
  labelled design-system primitives while preserving CrudForm validation and extension hosts.
- Generate patient numbers independently from persistence identifiers and pin the privacy
  invariant in API/browser regression coverage.
- Make lifecycle keyboard submission and browser scenarios deterministic, retaining the
  operator's input through optimistic-conflict recovery.

#### Step 2.7 — Resolve latest-main review conflict and import the VCAL source spec

- Merge the current `origin/main` without rewriting history so PR #3 remains reviewable.
- Preserve both the completed VIS implementation ledger and main's additive VCAL reference.
- Import the approved VCAL spec/assets and unrelated latest-main documentation/fixture updates
  unchanged, then rerun the full validation gate on the merged tree.

## Checkpoint and final verification

- Checkpoint after Phase 1: targeted generation/typecheck/unit/integration checks plus browser preview screenshots and PR evidence.
- Checkpoint after Phase 2: targeted generation/typecheck/unit/integration checks plus browser preview screenshots and PR evidence.
- Final gate: `yarn generate`, `yarn typecheck`, `yarn lint`, `yarn ds:check`, `yarn test`, `yarn build`, full `yarn test:integration:ephemeral`, and design-system review.
- One authoritative `om-auto-review-pr <PR> --autofix` pass follows the final gate.

## Risks

- The source spec began as Draft; Step 0.1 formalizes the explicit approval in this request before any runtime code lands.
- Visit snapshots contain sensitive health-context metadata; all direct reads must use scoped decryption and tests must avoid patient data in logs/events/screenshots.
- Shared patient row locks can dead-wait without a local timeout; every pessimistic lock must map SQLSTATE `55P03` to a retryable 409.
- Browser verification depends on the repo's ephemeral test environment. If it cannot run, implementation continues but the skipped UI portion is recorded in the checkpoint and PR as required by the selected workflow.
- Generated schema changes must remain additive and scoped; no migration application is authorized.

## External References

- None supplied. The source spec mockups and installed generated facts are the design evidence.
