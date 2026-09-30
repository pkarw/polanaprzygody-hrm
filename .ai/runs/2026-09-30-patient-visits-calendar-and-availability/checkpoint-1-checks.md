# Checkpoint 1 — VCAL-1 availability enforcement

**Completed:** 2026-09-30T19:48:59Z
**Implementation through:** Step 1.5 / `b07fae0`
**Preview:** production build on `http://127.0.0.1:3100`, dedicated task-only PostgreSQL database

## Targeted validation

| Check | Result |
|---|---|
| `yarn typecheck` | pass |
| `yarn lint` | pass — 0 errors; 8 pre-existing warnings outside the patient changes |
| `yarn ds:check` | pass — 325 files |
| `yarn jest src/modules/patient --runInBand` | pass — 28 suites / 289 tests |
| Focused availability/UI/API/date-time contracts | pass — 4 suites / 20 tests |
| `yarn build` | pass — 436 API route files generated and production build completed |
| `yarn db:migrate` | pass on the dedicated task database — one patient migration applied; no user/shared database touched |

The migration command emitted the known non-fatal query-index declaration warning for the patient migration import path; the migration itself completed, the production build passed, and the live app read/wrote the new fields.

## Focused integration and browser proof

- Existing VIS browser regression: `VIS-T08-ui-states.spec.ts` — 5/5 passed against the live build.
- Checkpoint scenario — 1/1 passed in the live browser:
  - created two same-time visits through supported APIs;
  - obtained the warning signature from the real `availability-check` route;
  - persisted a real override with exact acknowledgement and encrypted reason;
  - re-read and rendered the author, time, codes, and reason without exposing UUIDs;
  - exercised the shared warning/override dialog in light and dark themes;
  - exercised the blocking and degraded response UI at 360 px and desktop width.
- The warning/audit path uses real persisted records and the real API. The hard-block and transient-failure screenshots use browser route fixtures to deterministically cover those UI states; authoritative command enforcement is covered by unit/integration contracts and will receive the complete VCAL-T02–T10 suite in Step 2.4.
- No horizontal overflow was detected at 360 px.

## Screenshot evidence

- `checkpoint-1-artifacts/vcal-1-warning-audit-light.png` — real double-booking warning plus persisted override audit, light theme.
- `checkpoint-1-artifacts/vcal-1-override-dialog-dark.png` — exact-warning confirmation and reason field, dark theme.
- `checkpoint-1-artifacts/vcal-1-blocking-360-light.png` — non-overridable absence at 360 px.
- `checkpoint-1-artifacts/vcal-1-degraded-light.png` — explicit availability failure with retry.

## Checkpoint verdict

Pass. VCAL-1 is implemented and runnable. The next task is Step 2.1, the bounded calendar API with availability lanes.
