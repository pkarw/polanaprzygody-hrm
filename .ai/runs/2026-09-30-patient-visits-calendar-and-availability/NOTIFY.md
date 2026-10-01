# Notify — 2026-09-30-patient-visits-calendar-and-availability

> Append-only UTC log. No routine per-Step entries; checkpoints, blockers, important decisions, delegations, and run end only.

## 2026-09-30T18:52:49Z — run started

- Brief: implement the complete VCAL specification automatically after VIS, with commits/pushes throughout, browser verification and GitHub screenshots after every phase, final autofix review, and the latest app on port 3000.
- Decision: use a stacked PR based on `feat/patient-visits` because VCAL depends on the unmerged VIS aggregate in PR #3; `origin/main` is already included in that base.
- Decision: the user's explicit autonomous implementation instruction confirms the spec's reversible Q1–Q4 defaults and authorizes Step 0.1 to mark it ready.
- Delegation: an independent read-only subagent is auditing exact installed planner/resources/staff/ScheduleView contracts while the run folder and draft PR are established.
- Labels are disabled by repository configuration; claim visibility uses assignee plus the required claim comment.

## 2026-09-30T19:48:59Z — checkpoint 1 passed

- VCAL-1 Steps 1.1–1.5 are implemented and pushed through `b07fae0`.
- Validation: typecheck; lint with 0 errors; DS 325; 28 patient suites / 289 tests; production build; dedicated task-database migration; VIS browser regression 5/5; focused VCAL browser flow 1/1.
- Browser evidence: four reviewed PNGs cover real warning/override persistence and audit, the dark confirmation dialog, a 360 px hard block, and explicit degraded availability with retry.
- Decision: hard-block and transient-failure screenshots use deterministic browser route fixtures; the real warning/audit path uses supported APIs and persisted records. Full authoritative VCAL-T02–T10 integration coverage remains assigned to Step 2.4.
- Next: Step 2.1 calendar API and availability lanes.

## 2026-09-30T21:12:48Z — checkpoint 2 passed

- VCAL-2 Steps 2.1–2.6 are implemented and pushed through `5c73d94`; every Tasks row is done.
- Validation: typecheck; focused ESLint with 0 errors; DS 330; 20/20 focused unit contracts; production build; and 7/7 VCAL-T01–T10 API/browser scenarios on the dedicated task database.
- Browser evidence: five reviewed production-preview PNGs cover the real week grid, 360 px dark create form, degradation and non-interactive availability lanes, warning acknowledgement without parent double-submit, and a hard block.
- Blocker handled: Docker is unavailable, so the repository's ephemeral container runner could not start. Decision: use the documented dedicated-database fallback with repository-native Playwright and task-local Chromium libraries; no shared/user database was touched.
- Decision: installed `ScheduleView` exposes availability items as keyboard buttons, so selected availability windows are rendered in a visible, non-interactive lane summary adjacent to the grid; visit items remain the only actionable calendar events.
- Next: full gate, full patient integration suite, authoritative PR review/autofix, final PR report/ready transition, and final port 3000 preview.

## 2026-09-30T21:23:08Z — final-gate retry race corrected

- Full patient integration first pass completed with 93 passed, 4 expected host-capability skips, and one failed VIS-T06 concurrent idempotency assertion.
- Root cause: after availability enforcement was added, the serialized loser could observe the winner as a blocking overlap before reaching the unique index, bypassing the existing unique-violation replay recovery.
- Decision: recover an exact committed idempotent replay after expected 409/422 contention as well as after a unique-index race; infrastructure and side-effect failures remain visible.

## 2026-09-30T21:23:42Z — retry fix independently reviewed

- Delegation: a read-only subagent reproduced the live race as HTTP 201 + 422 and independently confirmed that conflict evaluation now precedes the unique-index recovery path.
- Review decision: narrow replay recovery to the two availability-decision errors (`visit_conflict_blocking` and `visit_conflict_unacknowledged`) plus the existing unique-index race, so unrelated 409/422 and post-commit failures cannot be hidden.

## 2026-09-30T21:36:02Z — final review availability degradation fix

- Authoritative review found that a transient `resources` QueryEngine failure escaped before the service's degradation boundary and could abort visit create/update instead of returning `availability_unknown`.
- Decision: catch only the failed resource-state read and degrade it to unknown; a successful read proving the resource inactive or absent remains fail-closed and blocking.
- A focused regression test distinguishes transient unknown state from an invented `resource_inactive` result.

## 2026-09-30T21:49:00Z — final review rollback decision and security-test delegation

- Authoritative review identified a data-loss blocker: VCAL-1 rollback dropped the four conflict-override audit columns even though the spec requires their data and history to survive.
- Decision: rollback removes enforcement indexes and the consistency check only; it retains audit columns, ciphertext, and the encryption-map entry. The forward DDL is repeatable so a later redeploy can restore enforcement without losing history.
- Delegation: a read-only subagent located repository-native raw-ciphertext, active encryption-map, and second-organization integration patterns; no files were edited by the subagent.

## 2026-09-30T21:56:00Z — final review integration-proof fix

- Added live raw-database proof that conflict override reasons are ciphertext and the exact field is present in the active scoped encryption map.
- The idempotent retry oracle now issues both requests concurrently and verifies one scoped database row for the shared request ID.
- Calendar and availability APIs are exercised from a second selected organization to prove that visits, lanes, and subject references do not cross scope.

## 2026-09-30T22:05:00Z — final review calendar-band fix

- Availability and exception windows now use the shared `ScheduleView` item contract so each window is aligned to its actual day and time inside the calendar grid.
- The grid bands are informational: the visible lane summary remains the screen-reader source, while band events are removed from the tab order, hidden from assistive technology, and made pointer-transparent so they cannot open visit actions.
- Browser coverage now requires both semantic band kinds in the grid and proves that neither band exposes a button or pointer interaction.

## 2026-09-30T22:18:00Z — live final-review runtime correction

- The first corrected live run reached the isolated QA database: five of seven focused scenarios passed.
- The cross-organization availability route correctly returned 422 with its established generic message; the test had guessed an optional `code` that the installed team-member reference path does not publish, so the oracle now checks the stable denial and proves the scoped ID is not leaked.
- `react-big-calendar` may attach the availability/exception class after inserting an event node. The accessibility normalizer now observes class changes as well as subtree additions, ensuring late-rendered bands are hidden from the accessibility tree and removed from pointer/tab interaction.
- A focused production rerun showed that the calendar can subsequently reconcile `tabindex` and classes on the same node without changing its kind. The normalizer is now idempotent and also watches those accessibility attributes, so any library reset is corrected without an observer loop.
- Root cause after the next focused rerun: query data can change while the loading branch still owns the DOM, so the data-dependent effect saw a null calendar ref and did not rerun when only the branch changed. A callback ref now starts and stops normalization exactly with the calendar root's mount lifecycle.

## 2026-09-30T22:19:00Z — final gate passed

- Full configured gate passed: generated outputs current, typecheck clean, lint 0 errors (8 unrelated pre-existing warnings), DS 330 files, 37 suites / 331 unit tests, and optimized production build.
- `yarn db:generate` reports `patient: no changes`; entity metadata, migration, and snapshot agree.
- Focused VCAL-T01–T10 passed 7/7. The complete patient suite passed 94 executable scenarios with 4 expected optional-host skips and zero failures.
- A visually reviewed 1280×1503 dark-theme screenshot proves the final availability and exception bands in the grid and is staged under `final-gate-artifacts/`.
- Delegation: the independent review agent is re-reviewing final head `e8dfcca`; the draft remains claimed until that clean verdict is recorded.

## 2026-09-30T22:31:00Z — final review accessibility fix

- The independent re-review found that grid bands were correctly hidden from assistive technology, but their text alternative exposed only times and could not distinguish windows on different dates.
- Decision: each lane-summary window now exposes a locale- and timezone-aware date-and-time range; browser coverage uses two dates and requires both distinct accessible dates.

## 2026-09-30T22:38:00Z — final review degradation logging fix

- The independent re-review found that intentional availability degradation was not represented in technical logs.
- Decision: emit one warning containing only a stable degraded-read class for member, resource, or planner failures; the exception, subject identifiers, names, and clinical data are never logged. A runtime logger-extension test proves the record is PII-free.

## 2026-09-30T22:45:00Z — final gate and independent review passed

- The post-review full gate is green: db/generate current, typecheck, lint 0 errors, DS 330, 37 suites / 332 unit tests, production build, and 94 executable patient integration scenarios with 4 expected optional-host skips and 0 failures.
- Final VCAL-T08 passed 2/2 and produced a visually reviewed 1280×1533 dark-theme screenshot with bands on two dates and distinct localized date/time text in the accessible summary.
- Independent final re-review of `9939551` returned `APPROVE`; 2 focused suites / 18 tests and `git diff --check` passed, with no blocker, major, minor, or nit findings.

## 2026-09-30T22:46:00Z — run completed

- Final evidence and screenshot were committed and pushed, PR #6 was refreshed with `Status: complete`, final-gate/review/summary comments were posted, and the draft was promoted to ready.
- The current verified production build is live through the workspace preview on port 3000; `/login` and `/api/healthz` return HTTP 200.
- PR: https://github.com/pkarw/polanaprzygody-hrm/pull/6
