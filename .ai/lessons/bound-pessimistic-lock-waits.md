---
title: "Bound every pessimistic row-lock wait, or contention becomes a dead request"
modules: ["patient"]
areas: ["module-data", "debugging"]
topics: ["optimistic-locking", "pessimistic-locking", "transactions", "timeouts", "idempotency"]
---

# Bound every pessimistic row-lock wait, or contention becomes a dead request

**Context**: Saving a diagnosis in the patient card failed with `Request failed (502)` and wrote nothing. The route was fine — replaying the request 1:1 against the running app returned 201. The message came from the dev-runtime gateway in front of the app (`{"error":{"code":"upstream_unavailable"}}`), which is what a proxy reports when a request never gets an answer. `lockPatient` takes `SELECT … FOR UPDATE` on the patient row, Postgres waits for a row lock **forever** by default, and this deployment sets no global `lock_timeout`. One holder — a concurrent save, or a transaction an abandoned request left open until `idle_in_transaction_session_timeout` reaped it two minutes later — was enough to make every following write to that patient a request that never returned.

**Problem**: A lock wait is invisible in every static gate: it type-checks, it lints, and unit tests never open a database. It is also invisible in the app's own error surfaces, because the request does not fail — it just never finishes, and whatever proxy sits in front reports its own timeout. So the symptom reaches the operator as an opaque gateway error on a page that looks otherwise healthy, and the obvious investigation (read the handler, replay the request) finds nothing wrong. Worse, the blocked transaction can still commit after the client has given up, so "the save failed" and "the save happened" are both true.

**Rule**: Wherever a command takes a pessimistic row lock, bound the wait inside the same transaction — `select set_config('lock_timeout', '<n>ms', true)` before the `FOR UPDATE` — and translate SQLSTATE `55P03` into a retryable 409 with a machine-readable code. Pick a bound far below any front-end read timeout and well above a healthy write. Never rely on a global `DB_LOCK_TIMEOUT_MS` being set; check it, and assume it is not. When a 502/504 appears on a write that replays fine in isolation, suspect a lock wait before suspecting the handler.

**Idempotent retry companion**: Two requests with the same client request ID can both miss the preflight replay check before the aggregate lock serializes them. After the winner commits, the loser may observe the new row as a domain conflict before it reaches the unique index. Recover only an exact committed replay with the same scoped request ID and digest, and only from the expected unique violation or the named conflict outcomes produced by that race; never turn every 409/422 into a replay. Prove the path with concurrent requests and a raw scoped row-count assertion.

**Applies to**: Every command that calls `lockPatient` in `src/modules/patient/` (patients, addresses, contacts, diagnoses, document links, attachment links) and any new module that serializes an aggregate with `LockMode.PESSIMISTIC_WRITE`. Oracle: `src/modules/patient/__tests__/lockWaitBound.test.ts`.
