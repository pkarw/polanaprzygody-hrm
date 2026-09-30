---
title: "Discount join rows of soft-deleted parents before declaring an orphan"
modules: ["resources", "planner"]
areas: ["module-data", "debugging"]
topics: ["seed-data", "soft-delete", "reconciliation"]
---

# Discount join rows of soft-deleted parents before declaring an orphan

**Context**: A bootstrap removed the core `resources` example set and then wanted to drop the example tags it left behind. `resources.resources.delete` soft-deletes the resource but leaves every `resources_resource_tag_assignments` row in place, so a live-assignment count never reached zero and no example tag was ever removed.

**Problem**: "Is this still referenced?" checks usually count join rows, and join tables rarely carry their own `deleted_at`. A soft delete of the parent therefore looks identical to a live reference, and the cleanup silently does nothing — a dry-run plan is what exposes it, not an exception.

**Rule**: When deciding whether a shared record (tag, category, type, dictionary entry) is orphaned, resolve the join rows back to their parents and ignore every parent that is soft-deleted or that the same run just removed. Never count join rows alone, and always render the decision into a dry-run plan you can read before executing.

**Applies to**: Seed, bootstrap, reconciliation, and cleanup routines over soft-deleted entities with join tables — `resources` tags/types, catalog categories, and any `*_assignments` table.
