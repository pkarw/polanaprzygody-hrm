# Execution plan — patient visits calendar and availability

**Mode:** spec-implementation
**Branch:** `feat/patient-visits-calendar-availability`
**Base branch:** `feat/patient-visits` (stacked on PR #3)
**Source spec:** `.ai/specs/2026-09-30-patient-visits-calendar-and-availability.md`

## Tasks

> Authoritative status table. `Status` is `todo` or `done`. Each Step lands in one lean commit; the first `todo` row is the resume point. `Exec` is fixed at planning time.

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 0 | 0.1 | Confirm autonomous assumptions and mark VCAL ready for implementation | inline | done | a78a4e8 |
| 1 | 1.1 | Implement the pure conflict engine and scoped availability adapter | inline | done | feb6dad |
| 1 | 1.2 | Add override audit fields, encryption, ACL, event, indexes, and migration | inline | done | 216ea6b |
| 1 | 1.3 | Enforce conflicts and exact acknowledgements in visit commands | inline | done | 9a4ff75 |
| 1 | 1.4 | Expose the scoped availability-check API and OpenAPI contract | inline | done | 77b9687 |
| 1 | 1.5 | Add shared availability and override UI to the VIS form | inline | done | 16fb62e |
| 2 | 2.1 | Expose the bounded calendar API with availability lanes | inline | done | 5232508 |
| 2 | 2.2 | Build the reusable calendar visit dialog on the VIS form | inline | done | 63488c0 |
| 2 | 2.3 | Deliver the ScheduleView calendar, filters, navigation, and list links | inline | done | 75c3bf3 |
| 2 | 2.4 | Complete VCAL-T01–T10 integration and browser coverage | dispatch | done | 3d73a6b |
| 2 | 2.5-review-fix | Fix independent Phase 2 review findings before runtime verification | inline | done | 4cd23af |
| 2 | 2.6-runtime-fix | Correct issues exposed by the live Phase 2 browser and API checkpoint | inline | done | fb5e598 |
| 2 | 2.7-gate-fix | Preserve idempotent visit retries after conflict enforcement serializes concurrent creates | inline | done | this commit |

## Goal

Deliver the complete VCAL specification so staff can plan and edit the same patient visits from a day/week/month/agenda calendar while server-side commands consistently detect therapist and room conflicts, block hard conflicts, and audit explicit warning overrides.

## Scope

- Extend the app-owned `patient:patient_visit` contract with four nullable override-audit fields, two partial busy indexes, encryption, validators, migration, ACL, and event declarations.
- Add a scoped patient availability service that reads public planner/resources contracts through optional DI/query seams and always degrades explicitly when planner data is unavailable.
- Recalculate conflicts inside the existing visit create/update transaction after bounded parent/aggregate locks; require exact warning signatures and a reason for overrides.
- Add `GET /api/patient/visits/availability-check` and `GET /api/patient/visits/calendar`, both with per-method metadata and OpenAPI.
- Reuse the VIS form in list and calendar entry points, and build `/backend/patient/visits/calendar` with the installed `ScheduleView` family, filters, URLs, accessibility, localization, and full quality states.
- Prove both phases against a dedicated task database and current local preview, with screenshots published on GitHub after each phase.

## Non-goals

- No drag-and-drop/resizing, recurring visits, public or portal booking, reminders, external calendar sync, waitlists, billing, pricing, or resource reservation writes.
- No edits to installed packages or generated registries, no new npm dependency, and no cross-module ORM relation.
- No copy of leave requests or planner rules in `patient`; the owners remain `staff`, `planner`, and `resources`.
- No retrospective job for visits that conflict with leave approved after scheduling.
- No migration of a user/shared database; local runtime proof uses only the dedicated disposable task database.

## Ownership and extension decisions

- `extension-mechanism`: app-owned patient service/API/UI reading installed public DI/query contracts; no installed record or page is mutated, replaced, or intercepted.
- `additive-before-replacement`: additive visit fields/routes/page and stable VIS form/list hosts; no replacement is needed.
- `extension-entity`: rejected because override state belongs to the existing app-owned visit aggregate, not a separate installed-host extension record.
- `eject-last`: rejected because the installed planner service, QueryEngine contracts, and ScheduleView surface are sufficient.
- Closest one-shot blueprint: an app-owned field-service/appointment scheduling slice (`M+B`, with bounded optional installed-module reads); durable workflow/provider routes are intentionally excluded.

## Implementation plan

### Phase 0 — readiness

#### Step 0.1 — Confirm autonomous assumptions and mark VCAL ready for implementation

- Treat the user's explicit autonomous implementation instruction as confirmation of Q1–Q4.
- Change the spec status to Ready for implementation and add a phase ledger/changelog entry without changing the accepted requirements.

### Phase 1 — availability enforcement

#### Step 1.1 — Implement the pure conflict engine and scoped availability adapter

- Add stable conflict codes/severities/signatures and half-open overlap behavior, including unknown-duration visits and minute normalization.
- Resolve planner rules, room state/ruleset, and overlapping patient visits with trusted tenant/organization scope, bounded inputs, public contracts, and explicit degradation.
- Add focused unit tests for the matrix, DST edges, optional planner absence, privacy redaction, and bounded reads.

#### Step 1.2 — Add override audit fields, encryption, ACL, event, indexes, and migration

- Add the four all-or-none override fields and partial busy indexes to `PatientVisit`, with request/response validators and encryption map.
- Add `patient.visits.override_conflict`, setup behavior, `patient.visit.conflict_overridden`, and focused contract tests.
- Run `yarn db:generate`, keep only scoped SQL/snapshot changes, inspect forward/rollback behavior, and do not apply it to a user database.

#### Step 1.3 — Enforce conflicts and exact acknowledgements in visit commands

- Recalculate after bounded locks inside the create/update transaction, preserving VIS lock ordering and optimistic concurrency.
- Block hard conflicts, require exact warning signatures/reason/feature for override, clear stale override state on clean writes, and emit identifier-only events after commit.
- Cover retry, idempotency, two-scope denial, races, audit/undo, and ciphertext behavior.

#### Step 1.4 — Expose the scoped availability-check API and OpenAPI contract

- Validate trusted-scope query inputs and return privacy-filtered conflicts without weakening command enforcement.
- Add per-method auth/features, OpenAPI enums and response shapes, error mapping, and route tests.

#### Step 1.5 — Add shared availability and override UI to the VIS form

- Add one debounced availability panel reused by create/edit flows and one guarded override dialog.
- Preserve form input and focus across 409/422, support Cmd/Ctrl+Enter and Escape, all async/denied/degraded states, PL/EN, both themes, and 360 px.
- Phase checkpoint: exercise real list-form create/edit/override/block flows in the browser and publish screenshots to the draft PR.

### Phase 2 — calendar

#### Step 2.1 — Expose the bounded calendar API with availability lanes

- Return scoped visits, public display snapshots, lanes, and degradation notes for a validated range of at most 62 days.
- Support therapist/room/patient/status filters without enumeration or clinical-detail leakage and add route tests.

#### Step 2.2 — Build the reusable calendar visit dialog on the VIS form

- Reuse VIS create/edit/lifecycle behavior inside a dialog seeded from a selected slot or event.
- Preserve optimistic conflict recovery, duplicate-submit protection, keyboard/focus, and authoritative calendar refresh.

#### Step 2.3 — Deliver the ScheduleView calendar, filters, navigation, and list links

- Add the server page/meta and narrow client island using the installed schedule family for day/week/month/agenda.
- Persist range/view/therapist/room/status in the URL, add navigation and list/calendar links, semantic status styles, accessibility, responsive layout, and full quality states.

#### Step 2.4 — Complete VCAL-T01–T10 integration and browser coverage

- Add self-contained real API/browser fixtures for calendar ranges, leave/manual rules, room rulesets, override ACL/signatures, scope/privacy, degradation, concurrency, and UI states.
- Run Phase 2 preview in light/dark and 360 px, capture day/week/month/agenda and conflict flows, and publish screenshot evidence.

## Checkpoints and final gate

- Checkpoint 1 fires after Step 1.5: targeted gate, VCAL-1 integration, live browser preview, screenshots, HANDOFF/NOTIFY rewrite, PR evidence.
- Checkpoint 2 fires after Step 2.4: targeted/full VCAL integration, live browser preview, screenshots, HANDOFF/NOTIFY rewrite, PR evidence.
- Final gate runs every configured validation command in order, full patient/VCAL integration, design-system review, and an authoritative `om-auto-review-pr --autofix` pass.

## Risks

- Planner/resources installed contracts may differ from spec-era assumptions; generated facts and exact installed exports are authoritative, and the independent contract audit runs before implementation.
- A conflict probe is advisory; only command-side recomputation under bounded locks is authoritative.
- Planner read failures intentionally degrade open, but auth/scope/reference ownership remain fail closed and are tested separately.
- Override reasons and staff absence reasons are sensitive; encryption, decryption, redaction, log/event exclusions, and screenshot hygiene are explicit gates.
- The PR is stacked on PR #3 because VCAL requires the VIS aggregate; the body and handoff must preserve that dependency.

## External references

- None supplied. The source spec, generated module facts, exact installed contracts, and repository guides are authoritative.
