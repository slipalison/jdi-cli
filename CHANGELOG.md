# Changelog

All notable changes to `jdi-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.16] - 2026-07-04

### Removed — Update notifier (opt-in feature removed entirely)
- `enable-update-check` / `disable-update-check` subcommands and their `bin/lib/jdi-check-update.js`, `jdi-check-update-worker.js`, `jdi-update-banner.js`, `jdi-toggle-update-check.js` implementation.
- `jdi install claude` no longer copies these 3 hook scripts to `<claude-dir>/hooks/`. Reason: this JS code was landing inside the consumer's own repository (`.claude/hooks/` under project scope), where it could be picked up by the consumer's own coverage/SonarQube/lint scans as if it were their code. JDI installs should only ship prompts/agents/docs into a project, never executable code that skews the consumer's own quality metrics.
- `JDI_NO_UPDATE_CHECK` env var (no longer applicable — nothing left to disable).
- README `enable-update-check` / `disable-update-check` section.

Existing installs that already have `.claude/hooks/jdi-*.js` on disk are unaffected by this change (install/update never delete files); re-running `jdi install` simply stops re-copying them. `npx jdi-cli@latest --version` / `npx jdi-cli doctor` remain the way to check your installed version manually.

## [0.1.13] - 2026-05-30

### Added — Enhanced orchestration (opt-in, host-neutral)
- `.jdi/config.json` gains `orchestration: { mode, source }` (`$schema_version` → `1.2`). `mode` defaults to `standard`; `enhanced` lets commands run optional multi-agent advisory layers when the host can fan out, degrading to the standard single-agent path otherwise. Off-path is byte-identical — a legacy config without the block reads as `standard`. Boolean capability switch, not a token ledger.
- `/jdi-new` and `/jdi-adopt` Step 4b: opt-in determined once at the top-level command turn (host capability seeds the default, user confirms) and persisted to config — sub-agents read it only from the file, never from host session state.
- `/jdi-verify` Step 4.5: reference consumer — opt-in, read-only Gate-8 Definition-of-Done critic that re-checks `Type=Auto/Status=PASS` rows for hollow passes. Emits a `## DoD Critic` REVIEW.md segment whose verdict the existing worst-case aggregation picks up. Can only tighten the verdict, never loosen it.
- `reviewer-specialist` template: `mode=dod-critic` branch (read-only, returns findings, writes nothing; orchestrator stays sole writer).
- `jdi-doctor` (`.sh` + `.ps1`): reports the active orchestration mode for the current project.

### Fixed
- `bin/jdi-build.ps1` now emits BOM-less UTF-8 (`Write-Utf8NoBom`) for all generated agents/skills. `Set-Content -Encoding UTF8` prepended a UTF-8 BOM under Windows PowerShell 5.1 (but not pwsh 7+), leaving `runtimes/` inconsistent with `jdi-build.sh` and causing ~60-file spurious churn across shells. Normalizes all 62 agent/skill adapters; since CI publishes committed `runtimes/` as-is, this removes the BOM from the published package.

## [0.1.12] - 2026-05-24

### Fixed
- `jdi-bootstrap` no longer writes hardcoded `next_step: /jdi-discuss 1` in STATE.md and orchestrator hints. Now reads first phase slug from `ROADMAP.md` and uses canonical slug (schema v2 default since 0.1.6). Integer fallback to `1` retained only for legacy v1 projects without slugs.
- Confirmation message after bootstrap now shows correct slug instead of `1`.
- Reported on OpenCode runtime but bug was runtime-agnostic — affected all 4 adapters.

## [0.1.11] - 2026-05-23

### Documentation
- README: new `enable-update-check` / `disable-update-check` section with explicit Claude-only runtime support note (OpenCode/Copilot/Antigravity schemas have no SessionStart hooks).
- README: explicit retrocompat invariant — `jdi install` never touches `settings.json`.
- README: `JDI_NO_UPDATE_CHECK=1` env var documented for runtime disable.

### Fixed
- `package.json` `description`: was "10 commands" (stale since 0.1.9). Now reflects current state — 15 slash commands, DoD as reviewer Gate 8, opt-in update notifier.

## [0.1.10] - 2026-05-23

### Added — Update notifier (opt-in)
- `bin/lib/jdi-check-update.js` — SessionStart hook entry. Spawns detached worker, exits immediately. Never blocks session start.
- `bin/lib/jdi-check-update-worker.js` — background worker. Reads installed version (env var → sibling `JDI_VERSION` file → walk-up package.json). Fetches `npm view jdi-cli version`. Custom semver compare. Writes cache to `~/.cache/jdi/jdi-update-check.json`. Fails silent on any error.
- `bin/lib/jdi-update-banner.js` — reads cache, emits `{"systemMessage": "jdi-cli update available: X → Y. Run \`npm install -g jdi-cli@latest\`"}` JSON envelope on SessionStart. 24h rate-limit on parse-error warnings.
- `bin/lib/jdi-toggle-update-check.js` — JSON-safe enable/disable for Claude Code's `settings.json`. Always backs up to `.bak` before edit. Idempotent.
- `npx jdi-cli enable-update-check [--scope user|project]` — merges 2 entries (check + banner) into `hooks.SessionStart` of `settings.json`. Preserves all other fields.
- `npx jdi-cli disable-update-check [--scope user|project]` — filters out JDI entries from `hooks.SessionStart`, keeps everything else. Hooks files remain on disk for fast re-enable.
- `JDI_NO_UPDATE_CHECK=1` env var — disables banner + worker at runtime, no settings edit needed.

### Changed
- `jdi install claude` now also copies the 3 update-notifier hooks to `<claude-dir>/hooks/` and stamps `{{JDI_VERSION}}` via `sed` / `Replace`. **`settings.json` is NEVER modified by install** — opt-in via `enable-update-check`.
- Install scripts (`.sh` and `.ps1`) strip BOM from hook source files at copy time (defense in depth — Node refuses BOM before shebang).
- `bin/jdi.js` help output lists the 2 new subcommands.

### Retrocompat invariant
- Users on 0.1.9 that re-run `jdi install` get hooks added to `.claude/hooks/` but **nothing else changes**. Banner stays off until explicit `enable-update-check`.
- Users who never re-install keep the 0.1.9 behavior verbatim. No silent behavior change ever.
- E2E test (`jdi-poc-todo/test-update-notifier.sh`, 32 checks) verifies a pre-existing `settings.json` (with `PreToolUse` hooks, `model` setting) is **byte-identical** before and after `jdi install`.

### Architecture credit
- Update-notifier pattern adapted from `gsd-build/get-shit-done`'s hook architecture (`hooks/gsd-check-update*.js` + `hooks/gsd-update-banner.js`). Cache location and JSON envelope shape are JDI-namespaced.

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

### Fixed
- `package.json` `files:` whitelist now includes `CHANGELOG.md` (was missing in 0.1.8 — file existed locally but was NOT shipped via npm publish).
- `dod-schema.md` `no TODO without issue` example: replaced PCRE look-ahead `(?!...)` with portable pipe pattern (`! { grep -RIn 'TODO' ... | grep -vE '#[0-9]+' | grep -q .; }`) so the example works on BSD grep (Mac default) and Git Bash without `-P` flag.

## [0.1.8] - 2026-05-21

### Fixed
- `jdi install` now copies Claude skills to `.claude/skills/` on install (`53a2441`).

## [0.1.7] - prior

- Align README/COMMANDS/ARCHITECTURE/PORTABILITY with schema v2.

## [0.1.6] - prior

- Slug-as-ID schema for multi-developer safety.
