# Notify — 2026-10-01-public-visit-booking-and-payment-links

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-10-01T14:17:59Z — run started

- Brief: implement PBOOK and VPAY with checkpoint tests, GitHub screenshots, and bounded subagents.
- External skill URLs: none.
- Decision: spec-implementation run; reuse the cockpit-linked worktree and use sequential cezar tasks for disjoint spec, bootstrap, and patient scopes.
- Decision: VPAY remains behind a readiness-review gate because its current status is Draft.

## 2026-10-01T14:20:00Z — installation and merge criteria expanded

- Decision: a fresh install must idempotently seed payment templates plus explicit duration/therapist/room booking values for every Polana service; manual post-install setup is no longer acceptable.
- Decision: after a clean automated review, the run adds automated UI QA with screenshots and merges only after all local, integration, QA, and required GitHub checks are green.
- Guard: the cockpit requires a final explicit confirmation immediately before merging into the base branch, even though merge intent is already recorded.

## 2026-10-01T14:21:30Z — draft PR opened and claimed

- PR: https://github.com/pkarw/polanaprzygody-hrm/pull/13
- Claim: assigned to `pkarw`; labels are disabled by `.ai/agentic.config.json`, so the guarded `in-progress` label is a no-op.

## 2026-10-01T14:23:10Z — subagents delegated

- `a644915c`: Step 1.1 implementation — fresh-context readiness/finalization of PBOOK and VPAY; editable scope is the two specs plus the Step 1.1 PLAN row.
- `7cf9a214`: read-only installed-contract investigation for checkout, custom fields, API keys/auth, queues, and email.
- `37eb1cae`: read-only integration/browser/screenshot environment investigation.
- Parallelism: three cezar children are in flight in disjoint scopes; no two may edit the same file.

## 2026-10-01T15:08:00Z — payment implementation delegated

- Step 1.2 seeded branded, valid checkout templates with focused tests.
- Steps 1.3–1.5 were delegated sequentially in the patient scope and landed as one commit per Step.
- Decision: multi-service visits use one fixed summed amount because the installed checkout `price_list` contract selects a single item; payment URLs use only the configured trusted application origin.
- Decision: checkout links carry an indexed `patient_visit_id`; orphan recovery requires exactly one scoped match and terminal `completed` state is absorbing.

## 2026-10-01T15:52:00Z — checkpoint 1 passed

- Steps: 1.1–1.5 (`a34cf35..1c8db09`).
- Verification: generate, typecheck, 364 patient tests, design-system check, production build, fresh isolated install, and Playwright browser path all passed.
- UI evidence: responsive/light and wide/dark payment states posted to PR #13 on the dedicated evidence branch.
- Environment decision: Docker-free QA uses isolated PostgreSQL 17 plus staged Chromium libraries; the existing Webpack dev fallback issue did not block the green production runtime.

## 2026-10-01T16:28:08Z — checkpoint 2 passed

- Steps: 2.1–2.3 (`497db67..4f770fd`).
- Verification: generate, 52 focused public-booking/bootstrap tests, typecheck, lint, production build, reviewed two-table migration/snapshot, and isolated fresh-install seed read-back all passed.
- Decision: materialize encryption maps before secret storage; provision the exact six-feature principal through installed public seams; commit API key and encrypted credential atomically with race recovery.
- UI evidence skipped: this phase changed only persistence/setup contracts; Phase 3 owns the first rendered public surface and screenshots.

## 2026-10-01T16:56:30Z — Step 4.1 contract review delegated

- `/root/submit_contract_review`: read-only inspection of exact customer, patient, visit, intake, origin, limiter, idempotency, compensation, and test seams for Step 4.1.
- Scope is read-only and disjoint from checkpoint files and the main session's implementation; parallelism remains within the cap.

## 2026-10-01T17:04:11Z — checkpoint 3 passed

- Steps: 3.1–3.3 (`ca990de..2c0890f`).
- Verification: generate, 11 focused public-auth/discovery/pricing/wizard tests, typecheck, lint, design-system check, and production build all passed.
- UI evidence: production runtime and real Chromium passed at wide and mobile viewports; home, live-pricing rendering, therapist selection, available-day focus, slot selection, and success feedback were captured.
- Test-data decision: pricing/availability fixtures were intercepted at the public HTTP boundary because the repository prohibits applying the new migration only for screenshot data; real API behavior remains covered by focused tests and Phase 5 integration tests.

## 2026-10-01T18:00:00Z — checkpoint 4 passed

- Steps: 4.1–4.4 (`91575bd..d9893bf`).
- Verification: generation, 54 focused public-booking/patient tests, typecheck, lint, design-system check, and production build all passed.
- UI evidence: real Chromium rendered the filled booking intake, PII-free thank-you route, and authenticated visit provenance/payment surface at 1440px with zero browser errors.
- Test-data decision: deterministic HTTP fixtures drive the screenshots because applying the new migration only for visual data is prohibited; the authenticated shell uses an isolated test tenant created under the current test encryption key.

## 2026-10-01T18:28:00Z — final implementation gate passed

- Steps: every Tasks row 1.1–5.3 is done; last implementation commit is `3e1f21e`.
- Verification: the full configured validation chain passed, including generation, typecheck, lint, design-system checks, unit tests, and production build.
- Integration: the complete repository-native suite passed with 103 tests passing and 4 conditionally skipped against a freshly initialized disposable PostgreSQL database and production server.
- Installation proof: initialization applied current migrations and seeded the Polana service mappings, checkout templates, public-booking identity, encryption maps, roles, users, and module defaults required for immediate operation.
- UI evidence: real Chromium passed the anonymous mobile success journey and authenticated wide visit payment/provenance keyboard journey; final screenshots are committed for PR publication.
- Environment decision: the native Testcontainers wrapper cannot start because this host has no Docker CLI. No tests were omitted: the same full suite ran against the run-owned PostgreSQL fallback.
2026-10-01T19:05:00Z — auto-review — CHANGES REQUESTED: independent security/data and UI/setup reviews found one payment-state race blocker plus supported-install, bounded-body, timezone, retry, worker-delivery, and real-success-path proof gaps. GitHub rejected a formal self-review, so the full report was posted as PR #13 comment 5938160959. Appended review-fix Steps 6.1–6.5; PR remains draft/in progress.

## 2026-10-01T20:36:32Z — checkpoint 5 passed

- Steps: 6.1–6.5, including the durable-email review fix.
- Verification: focused Jest 42/42, TypeScript, scoped ESLint, two fresh `--no-examples` installations, seed read-back, and the real Chromium PBOOK/VPAY journey passed.
- Installation proof: runtime-required catalog products, exact therapist/resource/duration mappings, nine checkout templates, public-booking identity, and both template/link/visit custom fields are created by default hooks; Stripe credentials remain an explicit external operator secret and were disposable test values only.
- UI evidence: Chromium rendered the actual seeded service's public checkout page at a real `/pay/<slug>` URL; screenshot stored in `checkpoint-5-artifacts/fresh-install-payment-link.png` for PR publication.
