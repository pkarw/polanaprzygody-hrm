# Checkpoint 3 — Phase 3 public discovery and availability

**Steps:** 3.1–3.3
**Implementation commits:** `ca990de..2c0890f`
**Recorded:** 2026-10-01T17:04:11Z

## Touched areas

- Fail-closed public API-key scope resolution, rate-limited catalogue/therapist/availability routes, promotion pricing, and planner degradation.
- Anonymous Polana shell, home, pricing, therapist cards, 60-day day strip, slot selection, responsive navigation, and accessibility feedback.

## Verification

| Check | Result | Evidence |
|---|---|---|
| `yarn generate` | PASS | Generated outputs unchanged and OpenAPI inputs valid. |
| Focused Jest (`publicAuth`, `publicDiscovery`, `publicPricingPage`, `bookingWizard`) | PASS | 4 suites, 11 tests. |
| `yarn typecheck` | PASS | No TypeScript errors. |
| `yarn lint` | PASS | Zero errors; eight pre-existing warnings outside the Step 3 files. |
| `yarn ds:check` | PASS | 375 files passed. |
| `yarn build` | PASS | Next.js production build compiled, typechecked, collected route data, and generated pages successfully. |
| Production browser smoke | PASS | Real cached Chromium against `yarn start`, wide and mobile viewports, no console/page errors. |

## Browser evidence

The production server used the isolated checkpoint PostgreSQL cluster. The public catalogue/availability responses were deterministically intercepted at the HTTP boundary so the new migration did not need to be applied solely for screenshots. This validates the real production route, hydration, responsive design, keyboard-capable controls, state transitions, and rendering; server/API behavior is independently covered by the focused tests above and Phase 5 integration coverage.

- [`checkpoint-3-artifacts/screenshot-home-wide.png`](checkpoint-3-artifacts/screenshot-home-wide.png) — anonymous wide home and public shell.
- [`checkpoint-3-artifacts/screenshot-pricing-mobile.png`](checkpoint-3-artifacts/screenshot-pricing-mobile.png) — 390px catalogue pricing with promotion and mobile navigation.
- [`checkpoint-3-artifacts/screenshot-booking-slot-wide.png`](checkpoint-3-artifacts/screenshot-booking-slot-wide.png) — selected therapist, focused available day, chosen slot, and success feedback.
- [`checkpoint-3-artifacts/browser-session.txt`](checkpoint-3-artifacts/browser-session.txt) — semantic assertions and browser error transcript.

## Result

Checkpoint 3 passed. Phase 4 can begin at Step 4.1.
