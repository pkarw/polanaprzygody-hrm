# Checkpoint 1 — payment-link capability

**Verified:** 2026-10-01T15:52:00Z
**Steps:** 1.1–1.5
**Commit range:** `a34cf35..1c8db09`
**Result:** PASS

## Touched areas

- PBOOK/VPAY specifications and backward-compatibility contracts.
- Fresh-install Polana checkout-template seeding.
- Patient visit payment fields, link lifecycle, commands, API routes, worker/subscriber, email, and staff UI.

## Checks

| Check | Result | Evidence |
|---|---|---|
| `yarn generate` | PASS | 439 API routes; patient worker and subscriber present in generated registries. |
| `yarn typecheck` | PASS | Independent root rerun after Step 1.5. |
| `yarn jest src/modules/patient --runInBand` | PASS | 34 suites, 364 tests. |
| Focused Polana/payment seed tests | PASS | 12 tests. |
| `yarn ds:check` | PASS | 344 files checked. |
| `yarn build` | PASS | Production Turbopack build and static-page generation completed. |
| Fresh isolated `yarn initialize` | PASS | PostgreSQL 17 with pgvector/pgcrypto; Polana catalog, staff, resources, custom fields, and checkout templates seeded without live credentials. |
| Playwright `VIS-T08` real-browser path | PASS | 1 scenario passed in 41.3s; responsive/light and wide/dark payment states captured. |

The development Webpack fallback could not bundle a framework-generated client bootstrap because of an existing server-only transitive import. The production Turbopack build and server ran successfully, so browser verification continued against the production runtime. No live database, PII, or provider credentials were used.

## GitHub evidence

- [Checkpoint verification comment](https://github.com/pkarw/polanaprzygody-hrm/pull/13#issuecomment-5935196797)
- [Checkpoint screenshots comment](https://github.com/pkarw/polanaprzygody-hrm/pull/13#issuecomment-5935197177)
- [Mobile payment section](https://raw.githubusercontent.com/pkarw/polanaprzygody-hrm/qa-evidence-checkpoint-1/checkpoint-1/checkpoint-1-payment-mobile.png)
- [Wide dark payment state](https://raw.githubusercontent.com/pkarw/polanaprzygody-hrm/qa-evidence-checkpoint-1/checkpoint-1/checkpoint-1-payment-wide-dark.png)
