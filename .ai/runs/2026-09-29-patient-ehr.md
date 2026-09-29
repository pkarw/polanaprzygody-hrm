# Execution plan — `patient` module (spec PAT)

**Date:** 2026-09-29
**Slug:** `patient-ehr`
**Branch:** `feat/patient-ehr`
**Source doc:** `.ai/specs/2026-09-29-patient-ehr-base.md`
**Spec PR:** #1 (design-only, `spec/patient-ehr-base`)
**Engine:** om-auto-create-pr (steps: 20, --loop: no)
**Status:** in-progress

## 🎯 Goal

Implement the PAT specification in full — every view and every feature of the standalone
`src/modules/patient/` module: the patient record with its own contact channel and addresses,
0..n CRM contact links, custom fields, the immutable diagnosis history, document links with a
resumable creation intent, and the clinical-file links — behind tenant/organization scope,
feature-based ACL, field encryption, optimistic locking and post-commit events.

## Scope

In scope — the whole PAT document:

- **PAT-1** — patient record, addresses, CRM contact links, custom fields, list/create/detail UI.
- **PAT-2** — diagnoses (create/correct/void) and document links (pin existing, create new, resume).
- **PAT-3** — patient and diagnosis clinical files, to the extent the installed host permits (see Risks).

Out of scope — the VIS specification (`2026-09-29-patient-visits.md`) in its entirety. The patient
list therefore ships **without** the "Kolejna wizyta" column; PAT explicitly assigns that column to
VIS-1, so its absence is the specified behaviour, not a gap. The archive/delete precondition that
VIS-1 adds ("a patient with undeleted planned visits cannot be archived") is likewise VIS's to add.

## Non-goals

Taken verbatim from the spec: prescriptions, lab results, allergies, medication, hospitalization,
legal consents, PESEL as an identifier, P1/NFZ, ICD as a mandatory dictionary, FHIR, portal
surfaces, AI, clinical OCR, notifications, automatic retention. No copying of CRM, the document
editor, or storage. No new npm dependencies. No edits to `node_modules`, `.mercato/generated/**`,
or shipped migrations.

## Readiness audit (repo-local override §1)

Run before planning, per `.ai/skills/om-auto-implement-spec/SKILL.md` §1 and
`.ai/skills/om-implement-spec/references/phases-and-gates.md`:

| Item | Verdict |
|---|---|
| 1. Status `Ready for implementation` | ❌ `Draft`, "Zgoda na implementację: pending" — **waived by explicit user approval** on 2026-09-29 ("implement full patient all views all features"). Step 20 records the approval in the spec. |
| 2. No blocking open questions | ✅ Q1 (two documents, one module) and Q2 (0..n visit services) both resolved. |
| 3. Requirement → AC + phase + self-contained oracle | ✅ PAT-R01…R07 all mapped in Requirement Traceability. |
| 4. UI routes cite installed reference, components, states | ✅ CRM people list/detail and example todo create/edit cited; `DataTable`/`CrudForm`/`AddressesSection` named; mockups rendered; PAT-T11 covers loading/empty/error/409/360px/light-dark/keyboard. |
| 5. API/command auth, scope, input, response, errors, concurrency | ✅ Route table plus the error matrix and mandatory `expectedUpdatedAt`. |
| 6. Phases with dependencies, tests, validation, exit gate | ✅ PAT-1/PAT-2/PAT-3 each carry them. |

## Deviations from the engine defaults, and why

1. **No nested worktree.** `om-auto-create-pr` step 5 wants an isolated worktree. This run is
   already a cezar task with its own checkout, and a fresh `git worktree` would not carry
   `node_modules`/`.mercato/generated`, which `yarn typecheck`, `yarn test` and `yarn build` need.
   The run therefore uses this checkout on `feat/patient-ehr`, branched off `spec/patient-ehr-base`
   so the spec and its mockups are present for reference.
2. **Labels skipped.** `.ai/agentic.config.json` sets `labels.enabled: false`, so the SDLC label set
   and its rationale comment are intentionally not applied.
3. **Implementation branched off the spec branch, not `main`.** The spec is not on `main` yet; it is
   in flight on PR #1. Once #1 merges, this PR's diff reduces to implementation only.

## Risks

- **SEC-ATT is a host gap, not a design gap.** The spec verified that
  `attachments/api/file/[id]/route.ts`, `api/image/[id]/[[...slug]]/route.ts` and `lib/access.ts`
  authorize scope and partition but **not** the patient feature or the link's parent, so any logged-in
  user of the organization who knows an attachment id can read a private clinical file. The spec
  forbids inventing a hook name or editing `node_modules`, and forbids "hardening" the old URL with a
  new link alone. Phase 5 therefore probes for an owner-authorization contract and, when it is absent,
  ships the model and the UI in an explicitly unavailable state (503 + a clear message) instead of a
  surface that looks protected and is not. PAT-AC06 cannot close on this host version; that is
  reported, not papered over.
- **Encryption maps must exist before real data.** `encryption.ts` declares the maps; a missing key or
  map must fail closed on a sensitive write rather than silently storing plaintext.
- **Concurrency on the primary address and the diagnosis chain.** Both need a parent lock plus the
  partial unique index; either alone permits two primaries or two successors.
- **Migration is generated and reviewed, never applied to validate.** `yarn db:generate` output is
  reviewed for `patient_*` tables only; applying it needs explicit approval.

## Implementation Plan

### Phase 1 — Module foundation and data model (PAT-1 step 1)

- 1.1 Module skeleton and registration: `index.ts`, `acl.ts`, `setup.ts`, `ce.ts`, `events.ts`,
  `extension-points.ts`, `i18n/{pl,en}.json`, and the `patient` entry in `src/modules.ts`.
- 1.2 `data/entities.ts`: Patient, PatientAddress, PatientContactLink, PatientDiagnosis,
  PatientDocumentLink, PatientAttachmentLink with the shared scope/audit/soft-delete columns.
- 1.3 `data/validators.ts` Zod schemas and `encryption.ts` field maps.
- 1.4 Generate the migration with `yarn db:generate`, review the scoped SQL and snapshot.

### Phase 2 — Commands, references and the record API (PAT-1 step 2)

- 2.1 `patientReferenceService` DI: scoped CRM person and staff team-member resolution with display names.
- 2.2 `commands/patients.ts`: idempotent atomic create with the first address, update, archive/restore, soft delete of an empty record.
- 2.3 `commands/addresses.ts` and `commands/contacts.ts`: primary-address switch under a patient lock, role flags, partial-unique invariants.
- 2.4 API routes `patients`/`addresses`/`contacts` with per-method `metadata` + `openApi`, plus command unit tests.

### Phase 3 — Patient record UI (PAT-1 step 3)

- 3.1 List surface: `/backend/patient/patients`, `PatientsTable`, `page.meta.ts`, navigation entry.
- 3.2 Create surface: `/backend/patient/patients/create` with `CrudForm`, first address, custom fields.
- 3.3 Detail shell `/backend/patient/patients/[id]` with tabs, the data group and custom fields.
- 3.4 Addresses tab on the shared `AddressesSection` adapter, and the CRM contacts tab.

### Phase 4 — Diagnoses and documents (PAT-2)

- 4.1 `commands/diagnoses.ts` create/correct/void plus the `diagnoses` and `[id]/correct|void` routes.
- 4.2 `commands/document-links.ts` link/new/resume/abandon plus the `document-links` routes.
- 4.3 Diagnoses tab: immutable history, correct and void dialogs with reasons.
- 4.4 Documents tab: pin existing, create new, resume a pending intent, unpin.

### Phase 5 — Clinical files (PAT-3, SEC-ATT gated)

- 5.1 `commands/attachment-links.ts`, the upload/file routes through the public `AttachmentService`,
  and the Files tab — gated on a proven owner-authorization contract, otherwise explicitly unavailable.
- 5.2 PAT-T09 denial probe over every host entry point, asserting the gate's real behaviour.

### Phase 6 — Coverage and the full gate

- 6.1 Integration specs `PAT-T01`–`PAT-T04` (record, contacts, addresses, custom fields).
- 6.2 Integration specs `PAT-T05`–`PAT-T07`, `PAT-T10`–`PAT-T12` (clinical history, documents, denial matrix, UI states, degradation).
- 6.3 Full validation gate: `yarn generate && yarn typecheck && yarn lint && yarn ds:check && yarn test && yarn build`.
- 6.4 Record the implementation ledger and the approval in the spec; run `om-code-review`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Module foundation and data model

- [x] 1.1 Module skeleton and registration — 56e12ba
- [x] 1.2 Entities for all six patient tables — 66a2d56
- [x] 1.3 Validators and encryption maps — 66a2d56
- [x] 1.4 Generated migration and snapshot review — 66a2d56

### Phase 2: Commands, references and the record API

- [x] 2.1 patientReferenceService DI — 3667752
- [x] 2.2 Patient commands — 3667752
- [x] 2.3 Address and contact commands — 27e6191
- [x] 2.4 Record API routes, OpenAPI and command unit tests — 92d1a1b

### Phase 3: Patient record UI

- [x] 3.1 List surface and navigation — c8ee0dc
- [x] 3.2 Create surface — 17abe28
- [x] 3.3 Detail shell, data group and custom fields — ea038d5
- [x] 3.4 Addresses and contacts tabs — ea038d5

### Phase 4: Diagnoses and documents

- [x] 4.1 Diagnosis commands and routes — 1d50b8e
- [x] 4.2 Document-link commands and routes — d78e5d3
- [x] 4.3 Diagnoses tab — 5a986dc
- [x] 4.4 Documents tab — 5a986dc

### Phase 5: Clinical files

- [ ] 5.1 Attachment links, upload/file routes and the Files tab behind the SEC-ATT gate
- [ ] 5.2 PAT-T09 denial probe

### Phase 6: Coverage and the full gate

- [ ] 6.1 Integration specs PAT-T01–PAT-T04
- [ ] 6.2 Integration specs PAT-T05–PAT-T07 and PAT-T10–PAT-T12
- [ ] 6.3 Full validation gate
- [ ] 6.4 Spec ledger, approval record and code review
