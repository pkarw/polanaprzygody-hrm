# Checkpoint 5 verification — Steps 6.1–6.5

**Recorded:** 2026-10-01T20:36:32Z
**Range:** `77e91e4..dd4b5d4`
**Outcome:** PASS

## Automated validation

- `yarn jest --runInBand` for Polana payment bootstrap, payment-link service, public discovery, submission, and auth — PASS; 5 suites, 42 tests.
- `NODE_OPTIONS=--max-old-space-size=8192 yarn typecheck` — PASS; zero TypeScript errors.
- Scoped ESLint for every changed Step 6.5 implementation/integration file — PASS; zero errors.
- `git diff --check` — PASS after normalizing the older checkpoint document.

## Fresh-install and integration verification

- A new empty PostgreSQL 17 database was initialized with `node scripts/mercato-cli.mjs init --no-examples` — PASS. The initialization applied the app migration chain and completed without example content.
- Scoped read-back — PASS: 8 catalog products, 9 checkout templates, 4 therapists, 7 active catalog custom fields, 13 active template custom fields, 14 active link custom fields, and 4 active visit payment fields.
- Disposable test-mode Stripe credentials were applied after initialization through the installed provider CLI. No live credentials or provider secrets are seeded by the application.
- Real Playwright/Chromium journey — PASS: seeded public service and therapist discovery, Warsaw-offset availability, two-request slot race (`201`/`409`), idempotent replay, staff confirmation, unique fixed-price checkout link, public pay page, durable payment-email enqueue/replay, and unpaid link deactivation.
- Native Testcontainers provisioning remains unavailable because this host has no Docker/Podman runtime; the equivalent isolated PostgreSQL environment is recorded above.

## Browser evidence

- Real seeded `Diagnoza logopedyczna` checkout page rendered at its generated `/pay/<slug>` URL with Polana branding and the resolved `PLN 300.00` fixed amount.
- `checkpoint-5-artifacts/fresh-install-payment-link.png`
