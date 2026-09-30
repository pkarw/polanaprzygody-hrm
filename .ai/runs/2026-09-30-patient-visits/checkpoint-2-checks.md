# Checkpoint 2 — VIS-2 lifecycle and settlement

**Recorded:** 2026-09-30T17:52:50Z
**Branch:** `feat/patient-visits`
**Last implementation commit:** `11c8ac7`

## Outcome

VIS-1 and VIS-2 are implemented and exercised through the real application against a
disposable PostgreSQL database. The browser coverage proves visit CRUD, lifecycle actions,
retained input after optimistic conflicts, closed read-only behavior, patient-card access,
next-visit projection, failure states, keyboard use, both colour schemes, and 360 px layout.

Browser verification also found and fixed inaccessible form labelling, a public patient
number that reused the persistence id, transient edit-form autofocus, and brittle test
selectors. No user or shared database was used.

## Targeted validation

| Check | Result | Evidence |
|---|---|---|
| `yarn generate` | pass | 435 API route files; generated outputs unchanged |
| `yarn typecheck` | pass | TypeScript completed with no diagnostics |
| `yarn build` | pass | optimized Next.js production build completed |
| focused unit/component tests | pass | 37 tests across command support and lifecycle actions |
| `yarn test:integration VIS-T` | pass | 18/18 real API/browser cases |
| `yarn test:integration PAT-T` | pass | 68/68 executable cases; 4 explicit optional-host skips |
| focused ESLint + `git diff --check` | pass | no diagnostics or whitespace errors |

## Browser checkpoint

- Preview: production build on `http://127.0.0.1:3100`.
- Data: isolated `cezar_vis_1c2b9461` PostgreSQL database initialized only for this run.
- Browser: repository Playwright Chromium with user-space runtime libraries; no OS-level
  installation or shared environment mutation was required.
- Five reviewed PNGs are stored in `checkpoint-2-artifacts/`: list/light, lifecycle
  dialog/dark, retained conflict reason/dark, closed read-only/dark, and actions/360 px/light.
- Screenshots contain synthetic names and operational content only; no real patient data.

## Environment note

The repository's Docker-based ephemeral wrapper remains unavailable because Docker is not
installed. Its intended isolation was reproduced directly with a dedicated database and the
same repository-native Playwright suites, so the gate executed rather than being skipped.
