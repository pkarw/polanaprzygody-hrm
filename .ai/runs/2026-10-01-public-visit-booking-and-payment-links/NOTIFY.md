# Notify — 2026-10-01-public-visit-booking-and-payment-links

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-10-01T14:17:59Z — run started

- Brief: implement PBOOK and VPAY with checkpoint tests, GitHub screenshots, and bounded subagents.
- External skill URLs: none.
- Decision: spec-implementation run; reuse the cockpit-linked worktree and use sequential cezar tasks for disjoint spec, bootstrap, and patient scopes.
- Decision: VPAY remains behind a readiness-review gate because its current status is Draft.

## 2026-10-01T14:24:00Z — installation and merge criteria expanded

- Decision: a fresh install must idempotently seed payment templates plus explicit duration/therapist/room booking values for every Polana service; manual post-install setup is no longer acceptable.
- Decision: after a clean automated review, the run adds automated UI QA with screenshots and merges only after all local, integration, QA, and required GitHub checks are green.
- Guard: the cockpit requires a final explicit confirmation immediately before merging into the base branch, even though merge intent is already recorded.
