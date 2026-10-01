# Checkpoint 2 — public-booking foundations

**Verified:** 2026-10-01T16:28:08Z
**Steps:** 2.1–2.3
**Commit range:** `497db67..4f770fd`
**Result:** PASS

## Touched areas

- `public_booking` module discovery, catalog booking definitions, setup, events, entities, validators, encryption maps, command, migration, and service-identity provisioning.
- Polana fresh-install fixture reconciliation for all eight service SKUs, therapists, and rooms.
- Patient command actor resolution for installed API-key auth contexts.
- PBOOK data/encryption/idempotency/provisioning contracts.

## Checks

| Check | Result | Evidence |
|---|---|---|
| `yarn generate` | PASS | Generated discovery/OpenAPI outputs are stable; 439 API routes. |
| `yarn test src/modules/public_booking src/modules/polana_bootstrap --runInBand` | PASS | 13 suites, 52 tests; includes exact eight-SKU seeds, encryption refusal, idempotent intake, two-scope identity isolation, and broken-key rotation. |
| `yarn typecheck` | PASS | No TypeScript errors. |
| `yarn lint` | PASS | Zero errors; eight pre-existing repository warnings only. |
| `yarn build` | PASS | Production Turbopack compile, TypeScript, page collection, and static generation completed. |
| `yarn db:generate` | PASS | Generated and reviewed `Migration20261001161632_public_booking.ts` plus module snapshot; only `public_booking_intakes` and `public_booking_service_credentials`, their scoped indexes, and the request-hash check are present. No migration was applied. |
| Fresh-install catalog seed read-back | PASS | Isolated PostgreSQL checkpoint environment resolved all eight SKUs to the exact configured duration, therapist `sourceId`s, and resource keys; three booking definitions and all relation rows were present. |
| UI/browser screenshots | SKIP | Steps 2.1–2.3 add persistence/setup contracts and no rendered surface; Phase 3 will capture the first public-booking UI evidence. |

## Decisions and limits

- Existing-tenant encryption maps are materialized before the credential secret is written.
- Service user/role uses `provisionExecutionPrincipal`; API keys use the installed `createApiKey` service after validating the exact scoped role.
- Key and encrypted credential are created in one transaction; a scoped uniqueness race retries from the committed winner without leaving an orphan key.
- The isolated PostgreSQL process used for migration generation and seed read-back was stopped after verification.
