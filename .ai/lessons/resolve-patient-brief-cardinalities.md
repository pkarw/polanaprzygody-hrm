---
title: "Resolve patient brief cardinalities before schema design"
modules: ["patient"]
areas: ["spec-pr"]
topics: ["requirements", "cardinality", "attachments", "scope-cohesion"]
---

# Resolve patient brief cardinalities before schema design

**Context**: The patient eHR brief described one catalog service per visit, while its diagram showed 0..n. The diagram also included an optional patient owner absent from the prose.

**Problem**: Silently selecting a cardinality changes the visit schema and editing flow. Ignoring the diagram loses an explicit relationship.

**Rule**: Read diagrams as requirement evidence. Record additional relationships and resolve contradictory cardinalities before designing tables. Splitting specification documents does not authorize another runtime module.

**Applies to**: `patient` specifications, especially service cardinality and patient ownership. On 2026-09-29 the user chose two specification documents within one patient module and zero-or-more services per visit. The resolved designs are `.ai/specs/2026-09-29-patient-ehr-base.md` and `.ai/specs/2026-09-29-patient-visits.md`; do not restore the contradictory one-service assumption.
