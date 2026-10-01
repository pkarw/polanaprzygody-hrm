# Public visit booking and payment links

**Date:** 2026-10-01
**Run mode:** spec-implementation
**Branch:** `feat/public-visit-booking-and-payment-links`
**Source specs:** `.ai/specs/2026-10-01-public-visit-booking-website.md`, `.ai/specs/2026-10-01-visit-payment-links.md`

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids and `Exec` cells are immutable once the plan is committed — per-Step commits touch only `Status` and `Commit`.

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 1 | 1.1 | Finalize both specifications and installation defaults | dispatch:capable | done | a34cf35 |
| 1 | 1.2 | Seed branded checkout templates for Polana services | dispatch:standard | done | 9fa8783 |
| 1 | 1.3 | Register visit payment fields and link creation service | group:A:capable | done | ff6c6f6 |
| 1 | 1.4 | Extend visit confirmation and manual payment-link APIs | group:A:capable | done | a739c7a |
| 1 | 1.5 | Add payment email, settlement lifecycle, and visit UI | group:A:capable | done | 1c8db09 |
| 2 | 2.1 | Scaffold public booking and catalog booking fields | inline | done | this commit |
| 2 | 2.2 | Persist encrypted booking intake and service credentials | inline | todo | — |
| 2 | 2.3 | Provision the scoped booking service identity | inline | todo | — |
| 3 | 3.1 | Expose scoped public services, therapists, and availability APIs | inline | todo | — |
| 3 | 3.2 | Build the public shell, home page, and live pricing page | inline | todo | — |
| 3 | 3.3 | Build accessible therapist and slot selection | inline | todo | — |
| 4 | 4.1 | Orchestrate hardened idempotent booking submission | inline | todo | — |
| 4 | 4.2 | Complete booking intake and thank-you UI states | inline | todo | — |
| 4 | 4.3 | Deliver booking confirmation emails after visit confirmation | inline | todo | — |
| 4 | 4.4 | Show online-booking provenance on visit details | inline | todo | — |
| 5 | 5.1 | Cover PBOOK API, scope, race, and retry integration paths | inline | todo | — |
| 5 | 5.2 | Cover VPAY link, email, and settlement integration paths | inline | todo | — |
| 5 | 5.3 | Add browser journeys and capture final UI evidence | inline | todo | — |

## Goal

Ship both approved business outcomes: anonymous public appointment booking backed by real catalog, availability, customer, patient, and visit records; and branded, visit-linked checkout payment links with staff controls and settlement feedback.

## Scope

- Implement all phases and acceptance paths in PBOOK and VPAY.
- Amend the approved specs so a fresh install seeds usable booking-field values and payment templates, then keep implementation traceability aligned with that operator decision.
- Add app-owned `public_booking` data, commands, public APIs, pages, email worker, setup, localization, and integration coverage.
- Extend installed `catalog` and `checkout` only through custom fields, commands, typed events, and supported services; extend app-owned `patient` directly.
- Add the two PBOOK tables and reviewed migration/snapshot, but never apply migrations.
- Exercise UI checkpoints with browser screenshots and publish checkpoint/final evidence on the draft PR.
- Preserve `patient.visit.confirmed` payload and existing visit behavior for staff-created visits.

## Non-goals

- Patient portal/login, self-service cancellation or rescheduling, SMS, CAPTCHA, refunds, invoices, automatic `isSettled`, payment-provider replacement, and scheduler-based reminders.
- Changes inside `node_modules`, generated registries, or shipped migrations.
- New durable workflow definitions or a new payment/email provider; the implementation composes the installed queue, checkout, Stripe gateway, and email transport.
- Applying migrations or using live provider credentials.

## Ownership and extension decisions

- `public_booking` owns intake/credential persistence and public orchestration.
- `patient` owns visit confirmation/payment behavior and its staff UI.
- Catalog product and checkout template/visit custom fields use additive UMES surfaces; no cross-module ORM relations.
- Cross-module writes use registered commands, reads use scoped services/scalar IDs, and async reactions use typed events/subscribers.
- `extension-mechanism`: custom fields + commands + typed subscribers; `additive-before-replacement`: yes; `extension-entity`: app-owned intake/credential records only; `eject-last`: rejected because installed seams cover the requirements.

## Implementation Plan

### Phase 1 — Payment-link capability

#### Step 1.1 — Finalize both specifications and installation defaults

- Perform an autonomous staff-level architectural/readiness review with fresh context.
- Add missing acceptance, traceability, compatibility, integration, and phase-gate detail; resolve only reversible gaps already implied by the approved decisions.
- Update PBOOK's prior manual-entry assumption: a fresh install must idempotently seed `booking_duration_minutes`, therapist relations, and room relations for every Polana service from explicit fixture mappings; later staff edits remain supported.
- Make the seed mapping auditable and deterministic (service SKU → duration → therapist fixture keys → resource fixture keys), with no “all therapists/all rooms” fallback.
- Mark VPAY ready only when the implementation-readiness matrix passes.

#### Step 1.2 — Seed branded checkout templates for Polana services

- Register template custom fields and idempotently seed one fixed template per catalog service plus the shared multi-service template.
- Replace generic checkout examples, preserve tenant/organization scope, and cover rerun/self-cleaning behavior with unit tests.

#### Step 1.3 — Register visit payment fields and link creation service

- Register non-editable visit payment custom fields.
- Implement scoped single- and multi-service link creation through `checkout.link.create`, custom-field writes, current pricing snapshots, and idempotent active-link reuse.
- Add unit tests for missing services/gateway, multiple services, and retry.

#### Step 1.4 — Extend visit confirmation and manual payment-link APIs

- Add optional `sendPaymentLinkEmail`, additive payment-link response fields, post-commit link creation, and the two manual action routes with metadata/OpenAPI/ACL.
- Preserve confirmation success when payment-link creation fails and preserve the existing event payload.

#### Step 1.5 — Add payment email, settlement lifecycle, and visit UI

- Add the localized React email, manual/automatic send path, transaction-completed subscriber, paid-unconfirm guard, and unpaid-link deactivation.
- Add the visit payment section, copy/resend/regenerate controls, conflict/error/loading/empty states, semantic status presentation, keyboard/a11y coverage, and tests.

### Phase 2 — Public-booking foundations

#### Step 2.1 — Scaffold public booking and catalog booking fields

- Register `public_booking`, its metadata/ACL/i18n/events/setup, and the three catalog booking fields with validation.
- Extend the Polana catalog fixtures with explicit booking defaults and seed the resolved therapist/resource IDs only after their owning fixtures exist; reruns update the intended values without duplicates or cross-scope leakage.
- Verify the existing catalog `CrudForm` relation/integer round trip; use the documented injection fallback only if the installed field renderer cannot satisfy it.

#### Step 2.2 — Persist encrypted booking intake and service credentials

- Add scoped `BookingIntake` and `ServiceCredential` entities, validators, encryption maps, idempotent intake command, events, tests, and a generated/reviewed migration.
- Store cross-module references as scalar IDs; encrypt requester snapshots, consent proof, and API-key secret.

#### Step 2.3 — Provision the scoped booking service identity

- Idempotently create the service user, least-privilege role/features, API key, and encrypted credential per tenant/organization.
- Resolve the key through the installed auth path, fail closed on missing/invalid scope, prefer `auth.userId` for UUID audit columns, and cover two-scope isolation.

### Phase 3 — Public discovery and availability

#### Step 3.1 — Expose scoped public services, therapists, and availability APIs

- Implement read services with promotion pricing, active therapists, and zero-conflict slots with an automatically selected resource.
- Add rate limits, input bounds, fail-closed scope, degraded planner behavior, per-method metadata/OpenAPI, and focused tests.

#### Step 3.2 — Build the public shell, home page, and live pricing page

- Add the explicitly unauthenticated public routes, localized Polana shell/theme, home hero, catalog-backed pricing, and loading/empty/error/mobile/a11y states.
- Use shared UI controls and keep brand tokens isolated to the public theme.

#### Step 3.3 — Build accessible therapist and slot selection

- Add therapist cards, date/slot selection, availability refresh/debounce, degraded/no-slot recovery, responsive horizontal navigation, focus preservation, and `aria-live` updates.

### Phase 4 — Submission, notification, and staff provenance

#### Step 4.1 — Orchestrate hardened idempotent booking submission

- Validate Origin/Host, fail-closed write limiting, deterministic UUIDv5 command request IDs, payload hashes, consent, and server-side slot revalidation.
- Match/create scoped customer and patient records without ambiguous reuse, atomically create the visit/intake path with compensation, and map 400/404/409/422/429/503 safely.

#### Step 4.2 — Complete booking intake and thank-you UI states

- Add requester/patient/address/consent fields, duplicate-submit protection, preserved values, first-invalid focus, slot-conflict recovery, localized errors, and thank-you route.

#### Step 4.3 — Deliver booking confirmation emails after visit confirmation

- Add the idempotent `patient.visit.confirmed` subscriber, module queue/worker, scoped decrypted reads, localized React email, and safe no-op for staff-created visits.

#### Step 4.4 — Show online-booking provenance on visit details

- Add a read-only localized panel gated by existing visit access and hidden for staff-created visits, with loading/error and narrow/dark/keyboard coverage.

### Phase 5 — Integrated verification

#### Step 5.1 — Cover PBOOK API, scope, race, and retry integration paths

- Implement the self-contained PBOOK integration matrix for custom fields, reads, matching, validation, concurrency, idempotency, limiter failure, credential scoping, and confirmation email behavior.

#### Step 5.2 — Cover VPAY link, email, and settlement integration paths

- Implement self-contained checkout-link integration coverage for single/multi service creation, retries, manual email, completion events, paid/unpaid unconfirm, and regeneration.

#### Step 5.3 — Add browser journeys and capture final UI evidence

- Explore the running app through the configured browser provider and add repository-native journeys for public booking and staff payment controls.
- Capture narrow/wide, key error, success, and keyboard states; store checkpoint artifacts and publish inline PR evidence.

## Checkpoints and gates

- Checkpoint 1 after Steps 1.1–1.5.
- Checkpoint 2 at Phase 2 close.
- Checkpoint 3 at Phase 3 close with public UI screenshots.
- Checkpoint 4 at Phase 4 close with public and backend screenshots.
- The final gate subsumes the Phase 5 checkpoint and runs every configured validation command, the full integration suite via `om-integration-tests`, and the design-system pass.
- After the authoritative `om-auto-review-pr --autofix` pass is clean, run `om-auto-qa-pr --self-qa-signoff` with real browser screenshots. Merge the ready PR into the configured base branch only when local gates, integration tests, automated review, UI QA, and required GitHub checks are green. The cockpit Guard will request final merge confirmation at that irreversible boundary.

## Risks

- VPAY is still marked Draft. Step 1.1 is a hard gate; later VPAY Steps cannot start until it is ready.
- Fixture-derived booking defaults are product data. The mapping must be explicit in reviewable fixtures and covered by idempotency/two-scope tests; guessing from free-text specializations at runtime is prohibited.
- PBOOK adds schema. `yarn db:generate` is authorized as a probe only; migration application remains prohibited without explicit approval.
- Public writes carry a real scoped service identity. Missing, ambiguous, or invalid tenant/organization/auth state must fail closed, and secrets/PII must never enter logs, events, responses, caches, or screenshots.
- Visit confirmation and action-route signatures are additive contract changes. The source specs and PR must retain the compatibility analysis required by `BACKWARD_COMPATIBILITY.md`.
- Checkout/custom-field reverse lookup may lack an installed service API. Resolve the named fact before implementation; use the approved symmetric scalar-ID fallback rather than cross-module ORM access.
- Browser dependencies may be absent. Follow the existing local Chromium lesson; if the app environment still cannot run, record the exact blocker without halting non-UI implementation.

## External References

- No `--skill-url` references were supplied.
- Market references embedded in PBOOK (Cal.com/Calendly) are design evidence only; repository rules and approved specs remain authoritative.
