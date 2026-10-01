# Final gate verification

**Recorded:** 2026-10-01T22:14:03Z
**Implementation head:** `5149785`
**Outcome:** PASS

## Full validation gate

- `yarn generate` — PASS; application registries and OpenAPI generation completed with 444 paths.
- `yarn typecheck` — PASS; zero TypeScript errors.
- `yarn lint` — PASS; zero errors and eight pre-existing warnings.
- `yarn ds:check` — PASS; 398 files checked.
- `yarn test` — PASS; 58 suites and 504 tests.
- `yarn build` — PASS; the production Next.js build compiled, typechecked, generated static pages, and finalized successfully.

The commands ran in the configured order as one chain: `yarn generate && yarn typecheck && yarn lint && yarn ds:check && yarn test && yarn build`.

## Fresh-install verification

- Created clean disposable databases for both `--no-examples` and standard example-enabled initialization in the run-owned local PostgreSQL 17 cluster.
- `node scripts/mercato-cli.mjs init --no-examples` completed against the current branch and applied the current app migration chain only to that new disposable database.
- The `--no-examples` installation seeded 10 customer identity projections for 10 customers, 9 branded checkout templates, one scoped public-booking credential, and all four required booking-field values for each of 8 services.
- The standard installation preserved the same 9 active/draft Polana templates and reconciled the 3 generic checkout example templates inactive after example seeding.
- The production server booted against the initialized database and served the full integration and browser suites, proving no manual template or custom-field setup is required after installation.

## Full integration suite

- Native command attempted: `yarn test:integration:ephemeral` — infrastructure-only failure before tests because no Docker CLI/container runtime is installed on this host.
- Equivalent full-scope fallback: production build on `127.0.0.1:3215` backed by the freshly initialized disposable PostgreSQL database.
- Repository-native command: `yarn test:integration` with the established `BASE_URL`, `DATABASE_URL`, browser cache, and staged Chromium library path.
- Final no-retry result: **104 passed, 4 conditionally skipped, 0 failed** across all 108 discovered cases.
- The passing set includes the new real-data `PBOOK-VPAY-T12` journey in addition to the PBOOK public HTTP/auth/idempotency and VPAY action-security/browser paths.

## Browser and accessibility verification

- `PBOOK-T11-browser.spec.ts` — PASS; Chromium completed the narrow anonymous booking flow and verified the success URL contains no requester PII.
- `VPAY-T08-browser.spec.ts` — PASS; Chromium rendered authenticated visit provenance/payment controls and exercised the generate/send actions by keyboard.
- `PBOOK-VPAY-T12-fresh-install.spec.ts` — PASS; Chromium consumed actual seeded services/availability, preserved confirmation when external Stripe credentials were absent, returned exact `gateway_not_configured`, and allowed unpaid unconfirmation without inventing provider secrets.
- Browser console/page errors — 0.
- Screenshot evidence:
  - `final-gate-artifacts/public-booking-success-mobile.png` (390×1068)
  - `final-gate-artifacts/visit-payment-and-provenance-wide.png` (1280×1601)
  - PR QA evidence `step-03-fresh-install-payment-link.png` (real configured-gateway `/pay/<slug>` page)

## Failure analysis from authoring runs

| Test / command | Primary reason | Evidence and resolution | Owner |
|---|---|---|---|
| PBOOK-T11 browser, first authoring run | Test issue | The observed Polish page did not match an English-only semantic selector. The Playwright error context and screenshot showed the rendered localized heading; the locator was changed to the observed bilingual role/name contract and the rerun passed. | Agent/QA |
| VPAY-T08 browser, first authoring run | Test issue | The observed visit surface used localized action labels that did not match the initial English-only selector. Error context and screenshot were inspected, selectors were aligned with the observed bilingual UI, and the rerun passed. | Agent/QA |
| `yarn test:integration:ephemeral` | Environment issue | The wrapper stopped before test discovery because Docker is unavailable. A newly initialized disposable PostgreSQL database and the production server supplied the equivalent clean environment; all 108 tests were then executed. | Shared |
| Full integration, first final rerun | Runner configuration issue | The app used the fresh database while Playwright's direct SQL assertions inherited the repository-default `DATABASE_URL`, producing false missing-row failures. The rerun supplied the same explicit database URL to both server and test process; all 108 cases then ran with 104 passes and 4 declared skips. | Agent/QA |

## Style compliance residual findings

- None. The configured `yarn ds:check` pass is green; no auto-fix Step or residual design-system exception is required.

## Auto-review fix re-gate

- Step `6.6-review-fix` preserves the installed checkout gateway error as `gateway_not_configured` and emits only the declared typed `patient.visit.updated` event after a changed payment-completion write.
- Focused regression result: 3 suites / 16 tests passed, including confirmation isolation and changed-versus-redelivered subscriber behavior.
- Full configured validation reran on `1045d5e`: generation found 444 API paths; typecheck passed; lint reported 0 errors and the same 8 pre-existing warnings; design-system checked 394 files; Jest passed 57 suites / 495 tests; production build passed.
- The production server was restarted from that build against `pbook_final_gate2`. The full repository-native Playwright suite passed again with **104 passed, 4 declared skips, 0 failed** across 108 cases.
- Fresh screenshots from the rerun cover the public mobile success flow, authenticated payment/provenance controls, and the real seeded branded `/pay/<slug>` page. Browser console/page errors remained zero.

## Final review and QA

- Independent final review at `5149785` — **APPROVE**, with no blocker, major, minor, or nit findings and no security, migration, or backward-compatibility regression.
- Focused review verification — 3 Jest suites / 22 tests passed; revised Playwright T12 discovered successfully; `git diff --check origin/main...HEAD` passed.
- `om-auto-qa-pr` verdict — **PASS**. Three screenshots and the scenario report were published inline on PR #13 from the dedicated evidence branch.
- External Stripe credentials remain intentionally operator-supplied; all app-owned templates, mappings, identities, custom fields, and encrypted credential storage are installed automatically.
