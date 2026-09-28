---
title: "Reconcile catalog categories against soft-deleted slugs"
modules: ["catalog"]
areas: ["module-data", "debugging"]
topics: ["seed-data", "soft-delete", "unique-constraints"]
---

# Reconcile catalog categories against soft-deleted slugs

**Context**: A scoped catalog bootstrap found no active category by display name and planned a create, while a soft-deleted row still owned the same tenant/organization/slug unique key.

**Problem**: Active-only or name-only discovery makes an idempotent bootstrap collide with the database unique constraint. A translated or renamed label can also refer to the same stable category.

**Rule**: Reconciliation must inspect active and soft-deleted categories in the exact tenant/organization scope, match the stable slug as well as the label, and restore a scoped soft-deleted match before linking products. Never work around the collision by inventing a second slug.

**Applies to**: Catalog category setup, seed, import, and repair routines.
