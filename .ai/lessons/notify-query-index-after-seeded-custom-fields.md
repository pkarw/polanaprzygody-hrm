---
title: "Notify the query index after seeded custom-field writes"
modules: ["staff", "entities", "query_index"]
areas: ["debugging", "module-data", "umes"]
topics: ["custom-fields", "query-index", "seed-data"]
---

# Notify the query index after seeded custom-field writes

**Context**: Seeded Staff custom-field rows existed in `custom_field_values`, while the standard Staff form received `null` values from its Query Engine projection.

**Problem**: Calling the low-level EAV helper writes durable values but does not notify the Query Engine. A response interceptor can hide the stale projection without repairing the canonical read path.

**Rule**: Seed installed-entity custom fields through `DataEngine.setCustomFields` with notification enabled, or use the owning command path, so the normal entity-updated event refreshes the query index. Rebuild an already-stale local index once, then verify the `cf:<key>` values in the indexed document without an API interceptor.

**Applies to**: Seed/setup code that populates custom fields for installed entities, especially `staff:staff_team_member`.
