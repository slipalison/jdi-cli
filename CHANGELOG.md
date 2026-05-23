# Changelog

All notable changes to `jdi-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] - 2026-05-21

### Added
- **Definition of Done (DoD) as Gate 8 of the reviewer specialist.** Phases now ship with an explicit, verifiable DoD captured in two layers:
  - **Project-wide baseline:** `PROJECT.md § Definition of Done` (LOCKED with PROJECT). Captured by `jdi-researcher` during `/jdi-new` Stage 2 via an interactive loop (5 candidates, cap 8 items). Applies to every phase.
  - **Phase-specific:** `CONTEXT.md § Definition of Done` (LOCKED with CONTEXT). Captured by `jdi-asker` during `/jdi-discuss` Stage 2 (5 candidates derived from D-XX + phase-type templates, free-add cap 10).
- **`core/templates/dod-schema.md`**: canonical specification for DoD block format, classification rules (Auto vs Manual), vague-item rejection, candidate generation, and verdict mapping.
- **Reviewer Gate 8**: parses both DoD blocks, runs `Verify:` for each item (executes for Auto, marks `MANUAL_REQUIRED` for Manual). Writes `## DoD Checklist` table in `REVIEW.md`.
- **New verdict `APPROVED_PENDING_MANUAL`**: gates 1-7 pass and DoD Auto items pass, but Manual items require explicit human confirmation before ship. `/jdi-ship` refuses this verdict.
- **New command `/jdi-confirm-dod <slug>`**: interactive loop to confirm/skip/reject each MANUAL_REQUIRED item. Confirmation requires evidence text. Idempotent — re-running resumes skipped items.
- **Vague-item rejection at capture time**: asker and researcher refuse DoD items lacking measurable `Verify:` field. Offers Reformulate / Drop / Convert to D-XX.

### Changed
- `jdi-asker`: new two-stage flow (Stage 1 = decisions, Stage 2 = DoD).
- `jdi-researcher`: new Step 3.5 captures DoD baseline before generating `PROJECT.md`.
- `jdi-reviewer-{slug}` template: 8 gates instead of 7 (UI was already gate 7; DoD is new gate 8).
- `jdi-verify` orchestrator: aggregate verdict logic recognizes precedence `BLOCKED > APPROVED_PENDING_MANUAL > APPROVED_WITH_WARNINGS > APPROVED`.
- `jdi-ship` orchestrator: refuses `APPROVED_PENDING_MANUAL`; re-verifies count of `MANUAL_REQUIRED` vs confirmations.
- `STATE.md` schema: new values `phase_status: pending_manual_dod` and `phase_verdict: APPROVED_PENDING_MANUAL`.
- `REVIEW.md` schema: adds `## DoD Checklist`, `## DoD Manual Confirmations`, optional `## DoD Rejected (post-hoc)` sections.
- `ARCHITECTURE.md`, `AGENTS.md`, `COMMANDS.md`, `MEMORY.md`: updated to reflect DoD layer and new command count (12 commands).

### Hard rules
- Every DoD item must have explicit `Verify:` — no exceptions.
- PROJECT § DoD is LOCKED after `/jdi-new`; changes require new D-XX + manual edit.
- CONTEXT § DoD is LOCKED after `/jdi-discuss`; changes require new D-XX in same phase.
- Reviewer is read-only — never modifies DoD blocks, never auto-confirms Manual items.
- Only `/jdi-confirm-dod` produces Manual confirmations (with mandatory evidence).
- Cap: 8 items in PROJECT § DoD; 10 items in CONTEXT § DoD per phase.

## [0.1.8] - 2026-05-21

### Fixed
- `jdi install` now copies Claude skills to `.claude/skills/` on install (`53a2441`).

## [0.1.7] - prior

- Align README/COMMANDS/ARCHITECTURE/PORTABILITY with schema v2.

## [0.1.6] - prior

- Slug-as-ID schema for multi-developer safety.
