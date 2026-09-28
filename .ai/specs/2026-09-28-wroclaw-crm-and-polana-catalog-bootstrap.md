# Wrocław CRM and Polana Przygody catalog bootstrap

**Date**: 2026-09-28
**Status**: Draft

## TLDR

Add one app-owned `polana_bootstrap` module that replaces installed `customers` and `catalog` example seeds with deterministic, tenant-and-organization-scoped fixtures. Fresh installations receive fictional Wrocław people and the eight services published at `https://polanaprzygody.pl/cennik`; Companies and Deals/Opportunities pages disappear through supported overrides. A guarded CLI reuses the bootstrap for local development, deleting every catalog-product custom-field definition and value in the selected scope only after dry-run, backup, and explicit confirmation.

## Problem Statement

Generic scaffold examples do not represent Polana Przygody, while Companies and Deals workflows are unwanted. Upstream edits would be unmaintainable and live website fetching would make installation nondeterministic. The app needs a reviewed snapshot, repeatable fresh-install behavior, and an explicit existing-database reconciliation path.

## Overview and Success Measures

- **Primary outcome:** Fresh scoped installs contain exactly the approved fictional people and eight Polana services, with no Companies or Deals UI.
- **Leading indicators:** Reruns create no duplicates; fixtures never cross scope; generated registries omit the disabled pages/widgets.
- **Baseline:** Installed generic customer/catalog examples and product fields.
- **Market / product reference:** Polana Przygody public JSON-LD captured 2026-09-28. Adopt names, descriptions, PLN prices, range and surcharge semantics; reject runtime scraping and unrelated booking/clinical features.

## Goals

- **REQ-001** — Seed ten clearly fictional Wrocław people with Polish names, `example.invalid` emails, and complete synthetic addresses.
- **REQ-002** — Disable Companies and all Deals/Opportunities pages and deal-only widgets while keeping People usable.
- **REQ-003** — Seed eight services, one default variant each, regular PLN prices, descriptions, categories, and approved custom fields.
- **REQ-004** — On explicit reconciliation, delete every catalog-product custom-field value and definition in the selected tenant/organization before installing the approved set.
- **REQ-005** — Make all operations idempotent, scoped, testable, and recoverable.

## Non-goals

- Continuous website synchronization; booking, clinical records, availability, or therapist scheduling.
- Removing Companies/Deals APIs or data models; this request hides their UI contributions.
- Deleting records outside the explicitly selected tenant and organization.
- Changing catalog price resolution or upstream public contracts.

## Proposed Solution

Create `src/modules/polana_bootstrap/` with setup, typed fixtures, a shared bootstrap service, guarded CLI, and focused tests. Register it in `src/modules.ts`. Replace `customers.setup.seedExamples` and `catalog.setup.seedExamples`; do not call their generic example seeds. Add supported `customers` page/widget overrides.

Commit price data with `sourceUrl` and `capturedAt`. Canonical catalog fields hold name, description, type/status, SKU, variant, currency, and regular price. Four product fields cover noncanonical source semantics: `session_details` (text), `price_max_pln` (number), `surcharge_amount_pln` (number), and `pricing_note` (text). Empty values are omitted. No pricing resolver is added.

The existing-database CLI defaults to dry-run. Execution requires explicit `--tenant`, `--organization`, `--backup`, and `--confirm-delete-all-product-custom-fields`. It reports counts, writes a JSON backup, then performs scoped cleanup/bootstrap. Missing or ambiguous scope fails before mutation.

### Design Decisions and Alternatives

| Decision | Rationale | Alternative | Why rejected |
|---|---|---|---|
| One module/spec | One installation policy owns fixtures and navigation | Separate deliveries | Product owner selected one coordinated spec. |
| Replace `seedExamples` | Supported contract prevents generic examples | Add another seed | Leaves unwanted data. |
| Snapshot website data | Reproducible/reviewable | Runtime fetch | Network failure and silent drift. |
| Hide UI, retain APIs | Smallest supported override | Remove APIs/ACL | Unrequested blast radius. |
| Four fields, no pricing extension | Represents range/surcharge safely | Custom resolver/schema | Unnecessary complexity. |
| Destructive reset only in CLI | Keeps ordinary setup reruns safe | Delete fields on every setup | Unacceptable data-loss risk. |

## Domain Vocabulary and Business Rules

| Term | Rule | Source of truth | Failure behavior |
|---|---|---|---|
| Bootstrap scope | Non-null tenant plus organization | Setup context/validated CLI | Fail closed; never choose first scope. |
| Fixture key | Stable SKU/email used for scoped upsert | Typed fixtures | Update match; never duplicate. |
| Service | Product + one default variant + regular PLN price | `catalog` | Partial transaction fails. |
| Range price | Regular price=min; `price_max_pln`=max | Captured snapshot | Both bounds, min ≤ max. |
| Surcharge | Metadata amount plus explanatory note; not auto-added | Captured snapshot | Amount without note rejected. |
| Full field reset | Delete all product values then definitions in scope | Confirmed CLI | Refuse without backup/flag. |

### Captured catalog snapshot

| SKU | Service | Regular price | Metadata |
|---|---|---:|---|
| `PP-DIAG-SI` | Diagnoza integracji sensorycznej | 750 PLN | 4 meetings: parent interview, two child meetings, parent review |
| `PP-DIAG-LOG` | Diagnoza logopedyczna | 300 PLN | 2 meetings; written report surcharge 150 PLN |
| `PP-DIAG-PSY` | Diagnoza psychologiczna | 700 PLN | Maximum 1000 PLN; depends on scope/meeting count |
| `PP-TER-LOG` | Terapia logopedyczna | 200 PLN | — |
| `PP-REDIAG-LOG` | Rediagnoza logopedyczna | 200 PLN | — |
| `PP-TER-SI` | Terapia SI | 200 PLN | — |
| `PP-TUS` | Trening Umiejętności Społecznych (TUS) | 120 PLN | 60 minutes, group session |
| `PP-KONS-PSY` | Konsultacja psychologa | 220 PLN | — |

## Users, Permissions, and Scope

| Actor | Outcomes | Scope | Features |
|---|---|---|---|
| Setup runner | Seed fresh-install fixtures | Trusted setup tenant/org | Setup contract |
| Local operator | Preview, back up, reconcile | Explicit tenant/org flags | Local CLI plus existing management access |
| Employee | Use People and Products | Selected organization | Existing `customers.people.*`, `catalog.products.*`, pricing features |

No system scope is allowed. Reject null organization, unknown IDs, cross-tenant organization ownership, and production mode.

## Reuse and Ownership Map

| Capability | Choice | Owner | Seam | Why |
|---|---|---|---|---|
| People/addresses | reuse | `customers` | installed persistence contracts | Preserve PII/search behavior. |
| Products/variants/prices | reuse | `catalog` | installed contracts | Preserve pricing/catalog behavior. |
| Installation policy | app-own | `polana_bootstrap` | replacement seed hooks | App-specific data. |
| Product fields | replace scoped definitions | `entities` + `catalog` | custom-field/Data Engine | No parallel schema. |
| UI visibility | extend | `customers` | unified overrides | Supported/reversible. |

## Architecture and Data Flow

```text
fresh setup ─┐
             ├─> bootstrap service ─> scoped people upserts
local CLI ───┘                    └─> scoped catalog upserts
local CLI -> dry-run -> JSON backup -> scoped field purge -> approved fields
src/modules.ts -> page/widget overrides -> generated navigation/registries
```

- **Module boundaries:** The app module owns policy; installed modules own records.
- **Extension points:** `overrides.setup.seedExamples`, `overrides.routes.pages`, deal widget override keys.
- **Compatibility:** No upstream contract changes. Removing overrides restores installed behavior.
- **Evidence:** `@open-mercato/core@0.8.1-develop.7266.1.8e520bbe03`; generated facts match installed source.

## User Journeys

### Journey J-001 — Fresh installation

1. Standard setup supplies trusted tenant/organization scope.
2. App hooks upsert ten people, approved fields, and eight services.
3. Employee sees People/Products but no Companies/Deals.
4. Retry produces no duplicates.

### Journey J-002 — Local reconciliation

1. Operator runs dry-run with explicit IDs.
2. CLI prints exact upsert/deletion counts.
3. Operator reruns with backup path and confirmation flag.
4. Backup succeeds before cleanup; failures leave data unchanged or produce actionable rollback evidence.

## UI and Interaction Contracts

No page is authored. Existing `/backend/customers/people` and `/backend/catalog/catalog/products` retain canonical `DataTable`/`CrudForm` states, accessibility, responsive behavior, and theming.

Disable Companies list/create/details; Deals list/create/details/map/pipeline; deal configuration/stage pages; and deal-only new-deals/analyzer/detail widgets. Navigation must disappear after generation/cache refresh. Direct access yields normal unavailable/not-found behavior. People and Products remain directly reachable.

## Data Models

No new entity/migration is planned. Reuse `customers:customer_person_profile` plus addresses, `catalog:catalog_product`, `catalog:catalog_product_variant`, `catalog:catalog_product_price`, and installed custom-field storage. Stable fixture keys are unique inside tenant+organization. Synthetic emails use `@example.invalid`. Prices use exact decimal semantics and PLN.

## API, Command, and Error Contracts

No HTTP API is added.

| Contract | ID | Input | Success | Errors/concurrency | Requirements |
|---|---|---|---|---|---|
| Setup hook | `polana_bootstrap.seedExamples` | trusted scope, EM/container | Idempotent fixtures | Missing scope fails; uniqueness prevents duplicates | REQ-001/003/005 |
| CLI | `polana-bootstrap install` | IDs, dry-run/execute, backup, confirmation | Counted JSON/text summary | Wrong scope, production, backup failure, missing confirmation fail before mutation; scoped lock prevents overlap | REQ-004/005 |

The CLI is a new stable contract and must be documented. No HTTP payload can select scope.

## Events, Jobs, Notifications, and Cross-Module Flows

No jobs/notifications. Use installed mutation/side-effect paths where available so cache/search follows normal behavior. Effects remain post-commit; any bulk indexing suppression must invoke the installed rebuild contract.

## Security, Privacy, and Compliance

- Existing feature gates protect CRUD; setup/CLI are operator-only.
- Every lookup/delete/upsert/unique key includes tenant and organization.
- Fictional PII still uses installed encryption helpers; logs contain counts/keys, not decrypted data.
- Dry-run is default; production is refused; backup and exact confirmation are mandatory.
- Only public price facts are captured; no live credentials or personal data.

## Integration Coverage

| Test | Level | Action | Assertions | Requirements |
|---|---|---|---|---|
| TEST-001 | integration | Run setup twice in empty scope A | Ten people/eight services once, exact values | REQ-001/003/005 |
| TEST-002 | security | Seed A, inspect/operate in B | No cross-scope visibility/modification | REQ-001/003/004 |
| TEST-003 | registry/UI | Generate and request routes | Companies/Deals/widgets absent; People/Products present | REQ-002 |
| TEST-004 | CLI integration | Dry-run scope with fields/values | Exact counts; zero writes | REQ-004 |
| TEST-005 | CLI integration | Execute with/without guards | Refusals no-op; confirmed backup then replacement | REQ-004/005 |
| TEST-006 | catalog integration | Resolve/list seeded prices | Fixed/range/surcharge semantics exact | REQ-003 |

## Implementation Phases

### Phase 1 — Module, navigation, and people

- **Depends on:** none
- **Outcome:** Fresh installs have Wrocław people and no Companies/Deals UI.
- **Deliverables:** module/setup, fixtures, scoped customer upserts, overrides, tests.
- **Requirements:** REQ-001/002 and customer part of REQ-005.
- **Tests/validation:** TEST-001 customer assertions, TEST-002/003; `yarn generate`, focused tests, `yarn typecheck`.
- **Exit gate:** Double seed yields ten people; generated routes/navigation satisfy REQ-002.

### Phase 2 — Catalog bootstrap

- **Depends on:** Phase 1
- **Outcome:** Fresh installs have the reviewed catalog/fields.
- **Deliverables:** typed snapshot, category/product/variant/price upserts, four fields.
- **Requirements:** REQ-003 and fresh-install part of REQ-005.
- **Tests/validation:** TEST-001 catalog assertions, TEST-006; focused tests/typecheck/lint.
- **Exit gate:** Double seed yields eight exact services.

### Phase 3 — Guarded reconciliation

- **Depends on:** Phase 2
- **Outcome:** Local scope can be backed up, field-reset, and reseeded safely.
- **Deliverables:** CLI, dry-run, backup, lock/transaction, docs/tests.
- **Requirements:** REQ-004 and remaining REQ-005.
- **Tests/validation:** TEST-004/005; broad gate and ephemeral integration test.
- **Exit gate:** Tests and broad gate pass; operator reviews dry-run and separately approves DB execution.

## Requirement Traceability

| Requirement | Journey | Contract | Phase | Tests | Acceptance |
|---|---|---|---|---|---|
| REQ-001 | J-001 | setup/customer records | 1 | 001/002 | AC-001 |
| REQ-002 | J-001 | page/widget overrides | 1 | 003 | AC-002 |
| REQ-003 | J-001 | setup/catalog/fields | 2 | 001/006 | AC-003 |
| REQ-004 | J-002 | CLI/backup/cleanup | 3 | 004/005 | AC-004 |
| REQ-005 | both | scope/idempotency/lock | 1–3 | 001/002/005 | AC-005 |

### Extension-surface traceability

| Requirement | Surface | Reference | Phase | Test | Classification |
|---|---|---|---|---|---|
| REQ-001/003 | app setup | `src/modules/example/setup.ts` (`module.setup`) | 1–2 | TEST-001 | emitted-example |
| REQ-002 | unified overrides | `src/modules/example/references/module-overrides.reference.ts` | 1 | TEST-003 | emitted-example |
| REQ-004 | app CLI | `src/modules/example/cli.ts` (`module.cli`) | 3 | TEST-004/005 | emitted-example |

## Rollout, Migration, and Rollback

No schema migration is expected. If implementation proves otherwise, run `yarn db:generate`, review scoped SQL/snapshot, and ask before application.

Generate, validate, inspect local scope, run dry-run, review backup destination/counts, then request final database confirmation. Rollback restores the JSON field backup and removes/reverts only stable fixture-key records. Removing overrides restores pages after regeneration/cache refresh. Retain backup through UI verification.

## Risks and Tradeoffs

| Risk | Impact | Mitigation | Residual risk |
|---|---|---|---|
| Full scoped field deletion | User metadata loss | Dry-run, explicit scope/flag, production refusal, backup | Restore may need review. |
| Website price drift | Stale seed | Source/date and reviewed updates | Manual maintenance. |
| Range uses base+metadata | Resolver returns 700, not range string | UI metadata/tests | Consumers must read metadata. |
| Hidden UI retains APIs | Privileged clients can use domains | Explicit non-goal | Future request needed to disable APIs. |
| Side-effect failure | Search/cache lag | Post-commit effects and convergence tests | May need documented rebuild. |

## Acceptance Criteria

- [ ] **AC-001** — Fresh scope gets exactly ten synthetic Wrocław people; rerun adds none; other scope sees none.
- [ ] **AC-002** — Companies and Deals pages/navigation/deal-only widgets are absent; People remains usable.
- [ ] **AC-003** — Eight services match captured content and PLN semantics, with only four approved fields.
- [ ] **AC-004** — Dry-run reports all scoped product fields; execute refuses without guards, then replaces all scoped fields without touching other scopes.
- [ ] **AC-005** — Focused tests and configured gate pass; DB execution occurs only after separate confirmation.

## Final Compliance Report

| Check | Status | Evidence |
|---|---|---|
| Rules/guides/skills reviewed | pass | Root, routed guides/skills, module facts, exact installed contract. |
| Models/contracts/tests consistent | pass | Reuse, TEST-001–006, traceability. |
| End-to-end workflows phased | pass | J-001/J-002, phases 1–3. |
| Platform-native reuse chosen | pass | Setup hooks, overrides, installed records/fields. |
| UI references/states covered | pass | Existing canonical surfaces retained; disabled matrix specified. |
| Phases bounded with exit gates | pass | Phase definitions above. |

Verdict: `Ready for implementation` after independent scope-cohesion review and product-owner approval.

## Open Questions

None. Resolved 2026-09-28: one spec; delete all product custom fields in selected scope; target current local development DB only after separate execution confirmation.

## Changelog

| Date | Change |
|---|---|
| 2026-09-28 | Drafted, resolved gate decisions, and completed implementation design. |
