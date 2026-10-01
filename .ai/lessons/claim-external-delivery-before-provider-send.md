---
title: "Claim external delivery before calling the provider"
modules: ["patient", "public_booking"]
areas: ["module-data", "umes", "testing"]
topics: ["queues", "email", "idempotency", "transactions", "ambiguity", "observability"]
---

# Claim external delivery before calling the provider

**Context**: Booking-confirmation and visit-payment emails were queued with scalar business IDs, but the provider call itself had no durable operation boundary. One worker held a database transaction across `sendEmail`; the other could send again whenever the queue redelivered its job. A crash after provider acceptance and before the local success marker therefore made “retry” indistinguishable from “send a duplicate.”

**Problem**: A database transaction cannot make an external provider call atomic. Keeping a row lock open around provider I/O only lengthens lock and connection occupancy; it cannot roll back a message the provider accepted. Conversely, marking success before the provider returns loses failures. Retrying a job that last reached `sending` risks duplicate delivery because acceptance is unknowable.

**Rule**: Persist a scoped operation as `pending` before enqueue, claim it as `sending` in a short committed transaction, call the provider outside every transaction and lock, then finalize `sent` in a new short transaction. A retry that observes `sending` must terminalize or retain `ambiguous` and must not call the provider again. Provider errors with unknowable acceptance are also terminal `ambiguous`; missing local prerequisites are terminal `failed`. Store and log only stable codes plus scope/operation IDs—never recipient data, provider payloads, credentials, or raw provider messages. Reusing an operation key recovers enqueue failure or HTTP retry; an intentional resend requires a new operation key and a new durable row.

**Applies to**: External email, webhook, notification, payment, shipping, or document-delivery workers in `src/modules/**/workers/`; app-owned delivery entities or state fields in `data/entities.ts`; and manual action routes that must distinguish transport retry from a deliberate resend.
