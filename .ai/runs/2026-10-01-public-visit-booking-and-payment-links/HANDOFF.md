# Handoff — 2026-10-01-public-visit-booking-and-payment-links

**Last updated:** 2026-10-01T15:52:00Z
**Branch:** `feat/public-visit-booking-and-payment-links`
**PR:** https://github.com/pkarw/polanaprzygody-hrm/pull/13
**Current phase/step:** Phase 2 Step 2.1
**Last implementation commit:** `1c8db09` — `feat(patient): add visit payment lifecycle UI`

## What just happened

- Phase 1 is complete: payment templates are seeded on install and visits support scoped link creation, manual send/regenerate, localized email, monotonic completion, paid-unconfirm protection, and accessible staff controls.
- Checkpoint 1 passed generate, typecheck, 364 patient tests, design-system checks, production build, fresh isolated installation, and a real Playwright browser scenario.
- Verification and responsive screenshots are published inline on PR #13; evidence lives on the dedicated `qa-evidence-checkpoint-1` branch, not the feature branch.

## Next concrete action

- Implement Step 2.1: scaffold `public_booking`, register catalog booking custom fields, preserve those fields during fixture cleanup, and seed deterministic SKU → duration/therapist/resource mappings after their owning fixtures exist.

## Blockers / open questions

- None. Public credential lookup must fail closed when the installation contains zero or multiple scoped candidates; later phases must not guess a scope.

## Environment caveats

- Docker is unavailable, but an isolated PostgreSQL 17 + cached Chromium path is proven and was used successfully.
- The dev runner's Webpack fallback hits an existing generated-bootstrap import issue; production Turbopack build/server is green and is the checkpoint browser runtime.
- The temporary checkpoint database is isolated under `/tmp` and must be stopped/removed after evidence capture.

## Worktree

- Path: `/workspace/.ai/cezar/worktrees/87e8b886-aaaa-46a3-bada-b4ead7d147fb`
- Created this run: no (reused cockpit-provided linked worktree)
