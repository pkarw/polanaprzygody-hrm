# Handoff — 2026-10-01-public-visit-booking-and-payment-links

**Last updated:** 2026-10-01T16:28:08Z
**Branch:** `feat/public-visit-booking-and-payment-links`
**PR:** https://github.com/pkarw/polanaprzygody-hrm/pull/13
**Current phase/step:** Phase 3 Step 3.1
**Last implementation commit:** `4f770fd` — `feat(public-booking): provision service identity`

## What just happened

- Phase 2 is complete: catalog booking fields and exact service values seed on install; encrypted intake/credential tables, idempotent intake recording, and reviewed migration/snapshot are committed.
- Fresh installs provision one non-login service user, exact six-feature role, API key, and encrypted credential per scope after materializing encryption maps.
- Checkpoint 2 passed generation, 52 focused tests, typecheck, lint, production build, migration review, and isolated seed read-back. No Phase 2 UI exists, so screenshots correctly defer to Phase 3.

## Next concrete action

- Implement Step 3.1: fail-closed scoped public read/auth bridge plus services, therapist, and availability APIs with bounds, rate limiting, OpenAPI metadata, planner degradation, and tests.

## Blockers / open questions

- None. Public routes must resolve a configured tenant/organization deterministically and authenticate through `resolveAuthFromRequestDetailed`; they must never select the first available scope.

## Environment caveats

- Docker is unavailable. The proven QA path uses an isolated PostgreSQL 17 cluster plus staged Chromium libraries.
- The checkpoint PostgreSQL process is stopped; recreate/start an isolated environment before Phase 3 browser verification.
- The dev runner's Webpack fallback has an existing generated-bootstrap import issue; production Turbopack is green and remains the browser runtime.

## Worktree

- Path: `/workspace/.ai/cezar/worktrees/87e8b886-aaaa-46a3-bada-b4ead7d147fb`
- Created this run: no (reused cockpit-provided linked worktree)
