# JDI — Commands

15 commands. 7 in the main loop + DoD confirmation (1) + brownfield entry (1) + ralph mode (1) + continuity (1) + roadmap mutation (2) + migration (1) + meta (1).

Every command that takes a phase accepts a **slug** (`auth-flow`, canonical) OR an **integer position** (`2`, display). Slugs are stable across branches; positions renumber on insert/remove. Schema v2 uses slug-as-ID; legacy v1 (numeric) projects keep working until you run `/jdi-migrate-phases`.

Phase status is never stored — it is **derived from the artifacts** in the phase folder: `SHIPPED.md` → done, `REVIEW.md` → verified, `SUMMARY.md` → executed, `PLAN.md` → planned, `CONTEXT.md` → discussed, nothing → pending. `STATE.md` is an advisory next-step cache for the local clone — untracked (gitignored) since 0.3.0 and regenerated from artifacts when absent; gates check artifacts, not STATE.

Phase helpers (resolver, slug validator, truncate, monitor) ship in the npm package and are invoked by the commands as CLI subcommands — `npx -y jdi-cli resolve-phase|validate-slug|truncate|monitor` (with `resolve-phase --json` for PowerShell). No helper code is copied into your repo.

## Main loop

### `/jdi-new "<description>"`

**Greenfield entry point.** Creates a JDI project from scratch. (Directory already has code? It suggests `/jdi-adopt` instead.)

```
/jdi-new "TODO app .NET 10 + React 19"
```

Does:
1. Validation: `.jdi/` does not exist (or `--reset`); if the directory has ≥3 code files, asks whether you meant `/jdi-adopt`
2. Spawns `jdi-researcher`:
   - 4 key questions (vision, stack, code-design, MVP features)
   - Optional focused research via ctx7 (max 2 lookups)
   - **Stage 2 — DoD baseline**: 5 project-wide candidates (test command, coverage threshold, no-TODO, CHANGELOG, README), per-item keep/edit/drop/replace, free-add cap 8
   - Generates `PROJECT.md` (vision + stack + code-design LOCKED + `## Definition of Done` LOCKED)
   - Generates `ROADMAP.md` (1 phase per MVP feature — **no per-phase status lines, no current-phase pointer**; status is derived from artifacts)
   - Generates `STATE.md` (schema v2) + `DECISIONS.md` (D-1: code design)
   - Creates `.gitattributes` (normalizes CRLF)
3. Writes `.jdi/config.json` (context budget, thresholds, compaction, coverage) + asks the enhanced-orchestration opt-in (`orchestration.mode`: standard | enhanced)
4. Initial commit: `chore(jdi): initialize <project_name>`

**Next:** `/jdi-bootstrap`

### `/jdi-bootstrap`

Creates per-project specialists (doer + reviewer).

Does:
1. Reads `.jdi/PROJECT.md` (+ detects `adopted: true` and the D-2 boundary commit on brownfield projects)
2. **Step 2.7 — multi-stack question (mandatory, never skipped):** auto-detects fullstack patterns from PROJECT.md (backend/frontend/mobile/infra keywords) and asks stack count. Single = 1 pair (default, 90% of projects); Multi = N pairs, each with `stack_label` + `file_glob` (pre-filled when detected, overlap-checked)
3. Spawns `jdi-architect` in `specialist` mode:
   - 6-9 focused questions — 6 base (test framework, build command, test command, coverage min, lint, conventions) + 3 frontend questions when a frontend is detected (dev server command, URL, critical paths). On adopted projects, defaults are pre-filled from the scan
   - Generates `.jdi/agents/jdi-doer-{slug}.md` (from `core/templates/doer-specialist.md`)
   - Generates `.jdi/agents/jdi-reviewer-{slug}.md` (from `core/templates/reviewer-specialist.md`)
   - Injects `<skills_to_load>` (principles + exactly ONE code-design skill resolved from PROJECT.md + frontend skills if applicable)
   - Updates `.jdi/specialists.md` + `.jdi/reviewers.md` + `.jdi/registry.md`
4. Commit: `chore(jdi): bootstrap specialists for <project_name>`
5. Prints the MCP audit checklist (token budget hygiene — non-blocking)

**Next:** `/jdi-discuss <first-slug>`

### `/jdi-discuss <slug|position> [--auto]`

Captures the phase's locked decisions.

```
/jdi-discuss auth-flow
/jdi-discuss 2                       # position also accepted (legacy/convenience)
/jdi-discuss auth-flow --auto        # asker decides everything, no questions
```

Does:
1. Validation: **doer + reviewer specialists exist (enforced gate — run `/jdi-bootstrap` first)** + phase resolves via `npx -y jdi-cli resolve-phase`
2. Spawns `jdi-asker`:
   - **Stage 1 — decisions**: 3-5 phase-specific gray areas, max 5 decisions per session, appended to DECISIONS.md — schema v2 uses collision-free IDs `D-{YYYY-MM-DD}-{phase_slug}-{seq}`; v1 keeps `D-N` increments
   - Scope creep -> `.jdi/todos.md`
   - **Stage 2 — phase-specific DoD**: 5 candidates derived from decisions + phase-type templates, per-item keep/edit/drop/replace, free-add cap 10
   - Vague items rejected (no `Verify:` field = does not pass)
   - Writes `.jdi/phases/{phase_dir}/CONTEXT.md` with a `## Definition of Done` section
3. Commit: `docs({slug}): capture phase context` + STATE update commit `chore(state): phase {slug} discussed`

**Next:** `/jdi-plan <slug>`

### `/jdi-plan <slug|position> [--review]`

Decomposes the phase into executable tasks.

```
/jdi-plan 2
/jdi-plan 2 --review     # shows preview, asks approval
```

Does:
1. Validation: CONTEXT.md exists; context budget warm-up via `npx -y jdi-cli monitor`
2. Spawns `jdi-planner`:
   - Reads PROJECT.md + ROADMAP.md + DECISIONS.md + CONTEXT.md
   - Decomposes into tasks (max 8) with `files_modified` + `acceptance` + `dependencies` + `test` (+ `specialist` per task on multi-stack — matched by file glob; tasks spanning 2+ globs are split)
   - Groups into waves (parallel within, sequential between)
   - Self-check (every task has files_modified? wave grouping respects deps?)
   - Writes `.jdi/phases/{phase_dir}/PLAN.md`
3. Commit: `docs({slug}): generate plan ({M} tasks, {W} waves)`

**Next:** `/jdi-do <slug>`

### `/jdi-do <slug|position> [--sequential]`

Executes the phase tasks via the project's doer specialist.

```
/jdi-do 2
/jdi-do 2 --sequential   # forces sequential even if waves allow parallel
```

Does:
1. Validation: PLAN.md exists + doer registered in `.jdi/specialists.md`; context budget warm-up via `npx -y jdi-cli monitor`
2. Resolves doer specialist(s) — single-stack: the one registered doer; multi-stack: each task's `**Specialist:**` field from PLAN.md (fallback: first registered doer)
3. Reads PLAN.md, identifies pending tasks, groups waves. **Fix mode:** zero pending tasks + REVIEW.md verdict BLOCKED (gate failure after all tasks completed — coverage, lint, …) → dispatches ONE doer in fix mode against the listed blockers instead of exiting; zero pending + no BLOCKED review → "already executed", exit 0
4. For each wave:
   - Intra-wave overlap check (files_modified disjoint?)
   - If parallel: sequential dispatch (ONE Agent per message with `run_in_background: true`); multi-stack waves may spawn DIFFERENT specialists in parallel (disjoint scopes)
   - If sequential: 1 doer per task in sequence
   - A blocked task in a non-final wave finishes the current wave then STOPS before the next (deps unsatisfiable) — phase marked `partial`
5. Doer updates task status in PLAN.md, commits atomically, writes the final SUMMARY.md
6. Orchestrator's final commit: `chore(state): phase <slug> executed`

**Next:** `/jdi-verify <slug>`

### `/jdi-verify <slug|position>`

Runs quality gates via the reviewer specialist.

Does:
1. Validation: SUMMARY.md exists + reviewer registered in `.jdi/reviewers.md`
2. Resolves reviewer specialist(s) — multi-stack chains ALL reviewers sequentially (never parallel — build/test ports and locks would clash), each scoped to its file glob
3. **Deletes any previous REVIEW.md** — REVIEW.md is a per-run artifact, recreated from scratch so stale verdicts can never poison the aggregation (git history keeps every prior run)
4. Spawns reviewer(s):
   - Gate 1: Build
   - Gate 2: Tests
   - Gate 3: Coverage (>= threshold)
   - Gate 4: Lint/Format
   - Gate 5: Security/Perf rules for the stack
   - Gate 6: Plan consistency (commits match files_modified)
   - Gate 7: UI Validation (conditional — only if `frontend.has_frontend: true`)
   - Gate 8: Definition of Done — parses `PROJECT.md § DoD` + `CONTEXT.md § DoD`, runs `Verify:` per item, classifies Auto PASS/FAIL and Manual MANUAL_REQUIRED
5. Optional enhanced DoD critic (only if `config.json orchestration.mode == "enhanced"` and the host can spawn read-only sub-agents): re-examines Auto-PASS DoD rows for hollow gates; can only make the verdict stricter
6. Reads the **aggregate verdict — worst-case across ALL verdict lines** (multi-stack has one per reviewer segment): BLOCKED > APPROVED_PENDING_MANUAL > APPROVED_WITH_WARNINGS > APPROVED. Legacy pt-BR `Veredicto:` lines are accepted. **Empty/missing verdict = malformed REVIEW.md → abort** (never ship on silence)
7. Reviewer writes `.jdi/phases/{phase_dir}/REVIEW.md` with verdict + `## DoD Checklist` table:
   - APPROVED — all gates PASS, no manual DoD pending
   - APPROVED_WITH_WARNINGS — no blockers, some warns, no manual DoD pending
   - **APPROVED_PENDING_MANUAL** — gates 1-7 OK, DoD auto PASS, but Manual items awaiting human confirmation
   - BLOCKED — gate 1-3 failed OR gate 5 critical OR gate 8 Auto FAIL OR gate 7 BLOCK
8. Commit: `docs({slug}): verify phase ({VERDICT})`

**Next:**
- `APPROVED` / `APPROVED_WITH_WARNINGS` → `/jdi-ship <slug>`
- `APPROVED_PENDING_MANUAL` → `/jdi-confirm-dod <slug>`
- `BLOCKED` → `/jdi-loop <slug>` (auto-fix) or manual fix + `/jdi-do <slug>` + `/jdi-verify <slug>`

### `/jdi-confirm-dod <slug|position>`

Interactive loop to confirm the `MANUAL_REQUIRED` DoD items left over from `/jdi-verify`. Blocks `/jdi-ship` until every item is confirmed or rejected.

```
/jdi-confirm-dod auth-flow
```

Does:
1. Validation: REVIEW.md exists + verdict ∈ `{APPROVED_PENDING_MANUAL, APPROVED, APPROVED_WITH_WARNINGS with leftover MANUAL_REQUIRED}` (BLOCKED aborts — fix gates first)
2. Extracts rows still `MANUAL_REQUIRED` from the `## DoD Checklist` table — **the table is the single source of truth**; rows already flipped by a previous run are not re-asked
3. Per-item AskUserQuestion:
   - `Confirm` (evidence text mandatory — URL/sha/path/description) → flips the row's Status cell `MANUAL_REQUIRED` → `CONFIRMED`
   - `Skip` (row stays `MANUAL_REQUIRED` — does not block this command, but still blocks ship)
   - `Reject DoD item` (justification mandatory — audited waiver) → flips the Status cell to `REJECTED` and records the reason under `## DoD Rejected (post-hoc)`. **A REJECTED row does NOT block ship**
4. Appends to `## DoD Manual Confirmations` and/or `## DoD Rejected` in REVIEW.md (idempotent)
5. Recomputes verdict from the table:
   - All resolved (confirmed/rejected) → upgrade to APPROVED or APPROVED_WITH_WARNINGS (prior warnings kept)
   - Any skipped → stays APPROVED_PENDING_MANUAL
6. Commit: `docs(<slug>): confirm DoD manual items (X confirmed, Y rejected, Z skipped, verdict <NEW>)`

**Idempotent:** re-running skips items already confirmed/rejected and resumes at the skipped ones.

**Hard rules:**
- Evidence is always mandatory (free text) — empty = invalid, re-asks
- Rejection always requires a justification — empty = invalid
- Confirmations are append-only, never deleted
- The command NEVER edits the PROJECT.md/CONTEXT.md DoD blocks (read-only there)

**Next:** `/jdi-ship <slug>` (once everything is resolved)

### `/jdi-ship <slug|position>`

Finalizes the phase, advances to the next.

Does:
1. Idempotency: if `SHIPPED.md` already exists for the phase → already shipped, exit 0
2. Validation: REVIEW.md exists + **aggregate verdict** (worst-case across all verdict lines; legacy `Veredicto:` accepted; empty verdict = abort) ∉ `{BLOCKED, APPROVED_PENDING_MANUAL}`
3. Re-verifies DoD freshness: counts rows still `MANUAL_REQUIRED` in the DoD Checklist — any remaining → abort, suggests `/jdi-confirm-dod`. (`REJECTED` rows are audited waivers and do not block)
4. If WITH_WARNINGS: asks "ship anyway?"
5. Writes the completion marker `phases/<slug>/SHIPPED.md` (`shipped_at`, `verdict`, `by`) — **team-safe: completion lives in the phase folder, not in ROADMAP.md**, so two developers shipping different phases on different branches produce zero merge conflicts. **ROADMAP.md is not touched** — except on legacy pre-0.2.0 ROADMAPs that still carry `- **Status:**` lines, where this phase's line is updated to `done` best-effort (never added where absent)
5b. Distills `SHIPPED.md § Learnings` — ≤5 one-line bullets from REVIEW.md warnings/blockers/waived DoD items + SUMMARY.md blocked tasks (section omitted when nothing qualifies). Planner and doer of the next phases read the last 3 and convert recurring items into acceptance criteria
6. Updates STATE.md (untracked advisory cache: next phase position + slug, `phase_status: ready`, next step — or `all_phases_complete: true` on the last phase)
7. Archives old phases per `config.json compaction.archive_after` (default 5) into `.jdi/archive/` (+ index)
8. Commit: `feat(<slug>): ship phase ({VERDICT})`
9. Optional tag: `phase-<slug>` (if PROJECT.md has `tag_phases: true`)

**Next:** `/jdi-discuss <next-slug>` (or done)

## Brownfield entry

### `/jdi-adopt ["<description>"]`

Adds JDI to a project that **already has code**. Replaces `/jdi-new` for existing projects.

```
/jdi-adopt
/jdi-adopt "Orders REST API, legacy, want to add reporting"
```

Does:
1. Validation: `.jdi/` missing + directory has ≥3 code files (otherwise suggests `/jdi-new` for greenfield)
2. Spawns `jdi-adopter`:
   - Automatic scan (manifests, layout, git log, README)
   - 5 questions (stack, code-design, vision, new features, LLM)
   - Optional web research (max 2 lookups)
   - Generates PROJECT.md (with `## Existing assets` — context, NOT a TODO) + ROADMAP.md (new features only) + STATE.md (`adopted: true`) + DECISIONS.md (D-1: code design — **ALWAYS confirmed with the user before locking**; D-2: boundary commit hash)
   - Initial commit
3. Verifies outputs (`adopted: true` flag, D-2 boundary present)
4. Writes `.jdi/config.json` + enhanced-orchestration opt-in (identical to `/jdi-new`)

The D-2 boundary means the reviewer enforces coverage only on files created AFTER adoption — legacy code is not held to the 80% gate.

**Next:** `/jdi-bootstrap` (adopted-aware: pre-fills detected test framework/lint, coverage only on new files)

## Ralph mode

### `/jdi-loop <slug|position> [--max-iter=5] [--max-resets=3] [--reset-loop]`

**Ralph loop mode.** Runs `/jdi-do` -> `/jdi-verify` in an automatic cycle until an APPROVED verdict. No human action between iters. Absolute cap: 5 iter per round x 3 resets = 15 iter.

```
/jdi-loop 2
/jdi-loop 2 --max-iter=3 --max-resets=2    # more conservative cap
```

Does:
1. Validation: PLAN.md + doer + reviewer registered
2. Initializes `.jdi/phases/{phase_dir}/LOOP.md` (or resumes if it exists):
   - `converged` → abort (run `/jdi-ship`)
   - `killed` → abort (hard cap is final) — **recovery only via `--reset-loop`**: after revisiting PLAN/CONTEXT, confirms, archives the old file as `LOOP.md.killed-{ts}` (audit preserved) and starts fresh
   - `escalated` / `paused` → resuming **CONSUMES A RESET** (`total_resets++`; hitting `max_resets` kills instead) — otherwise abort→re-run would zero the counter for free and bypass the absolute cap
   - `running` → resume at current iter (session-crash case; does NOT consume a reset)
3. Loop:
   - Spawns doer (with last REVIEW.md findings + LOOP history as context)
   - Spawns reviewer (read-only, writes REVIEW.md)
   - Parses the aggregate verdict (worst-case; legacy `Veredicto:` accepted; empty verdict = abort)
   - Hashes blockers/warnings -> appends to LOOP.md history
   - Verdict APPROVED or APPROVED_WITH_WARNINGS -> converged, exit → `/jdi-ship`
   - Verdict **APPROVED_PENDING_MANUAL** -> exits cleanly routing to **`/jdi-confirm-dod`** (the loop cannot confirm manual DoD items; ship would refuse anyway)
   - Finding hash equal to ANY hash of the **current round** (window since the last RESET/RESUMED marker — catches A/B/A/B period-2 cycles) -> oscillation detected, AskUserQuestion
   - iter >= max_iter -> AskUserQuestion (continue/abort/adjust)
4. Human gate options:
   - `Continue` -> reset counter, new round (total_resets++)
   - `Abort` -> status=escalated, clean exit
   - `Adjust plan` -> status=paused, exit, user edits PLAN/CONTEXT, re-runs /jdi-loop
5. Hard cap: total_resets >= max_resets -> status=killed, absolute kill switch
6. Each iter = atomic doer commit + reviewer commit (granular audit trail in git). **Every terminal transition (converged/killed/escalated/paused) commits LOOP.md** (+ STATE.md only on legacy projects that still track it) — the loop never leaves the tree dirty

**Generator/Judge separation:** doer writes, reviewer reads (read-only). Ralph invariant.

**When to use:**
- Phase with reliable automated tests
- Mechanical tasks (refactor, test coverage, batch fixes)
- You want "fire and forget" with a controlled cap

**When NOT to use:**
- Tasks needing human architectural decisions
- Phase with subjective gates
- Vague specs (it will oscillate)

**Next:** `/jdi-ship <slug>` (if converged), `/jdi-confirm-dod <slug>` (if pending manual DoD) or human review (if killed/escalated/paused)

## Roadmap mutation

### `/jdi-add-phase "<name>" [--goal "<text>"] [--slug <slug>] [--before <slug>|--after <slug>] [--reason "<text>"]`

Registers a new phase in ROADMAP.md. **Slug-as-ID** — strict validation + uniqueness before any write. Multi-developer safe.

```
/jdi-add-phase "User authentication" --goal "Login + signup + JWT"
/jdi-add-phase "Payments" --slug payments --after auth-flow
/jdi-add-phase "Hotfix" --before payments
```

Does:
1. Validation: `.jdi/ROADMAP.md` exists (STATE.md regenerated from artifacts if absent)
2. Detects `schema_version` (on v1, advises running `/jdi-migrate-phases`)
3. Derives the slug from `name` (or uses `--slug` if given)
4. Validates the slug via `npx -y jdi-cli validate-slug --check-unique`:
   - Shape: `[a-z][a-z0-9-]{2,39}`, no `--`, no trailing `-`
   - Reserved words (12): `current`, `all`, `none`, `archive`, `removed`, `history`, `latest`, `pending`, `ready`, `done`, `blocked`, `partial`
   - Uniqueness vs `.jdi/phases/` + ROADMAP entries
   - Named exit codes: 1 shape, 2 reserved, 3 duplicate, 4 ambiguous (corrupt folder forms)
5. Resolves the insert position (`--before`/`--after`/append). Refuses `<= current_phase`.
6. Writes the block to ROADMAP.md — **heading + Slug + Goal only. No `Status:` line** (status is derived from artifacts; legacy ROADMAPs keep their existing Status lines, new blocks never add one). Inserting shifts subsequent heading numbers; **slug values are never changed**
7. Recomputes `total_phases` (display counter)
8. Audit trail (only with `--reason`): appends `D-{YYYY-MM-DD}-{slug}-1: Phase '{name}' added. Reason: {reason}.` to DECISIONS.md (collision-free across branches)
9. Commit: `chore(jdi): add phase <slug>` (scope = slug, stable across merges)

Legacy `--at <pos>` (integer) accepted **on v1 only**; rejected on v2 with a hint to use `--before`/`--after` (positions shift between branches, slugs do not).

**Next:** `/jdi-discuss <slug>` (when ready to start)

### `/jdi-remove-phase <slug|position> [--force]`

Removes a pending/future phase from ROADMAP.md. Refuses on current/past/done.

```
/jdi-remove-phase auth-flow
/jdi-remove-phase 4 --force        # with artifacts -> archives, never deletes
```

Does:
1. Resolves the phase via `npx -y jdi-cli resolve-phase`
2. Hard refuses:
   - `position < current_phase` → past = history
   - `position == current_phase` → ship/abandon first
   - phase already done (shipped) → history
3. If artifacts exist: requires `--force` (or aborts with hint)
4. AskUserQuestion confirms (always, even with --force)
5. Moves the folder to `.jdi/archive/removed-<slug>/` (preserve history)
6. Removes the block from ROADMAP, renumbers display headings, recomputes `total_phases`
7. Appends to DECISIONS.md (audit trail: `D-{YYYY-MM-DD}-{slug}-rm`)
8. Commit: `chore(jdi): remove phase <slug>`

Slugs of the remaining phases **never change**.

## Continuity

### `/jdi-status`

Read-only snapshot. No agent invoked. Safe anytime.

Prints:
- Project + schema_version
- Current phase (slug + position + name)
- **Phase status DERIVED from artifacts** (`SHIPPED.md` → done, `REVIEW.md` → verified, `SUMMARY.md` → executed, `PLAN.md` → planned, `CONTEXT.md` → discussed, nothing → pending) alongside the STATE.md hint
- Verdict + shipped-phase count (`SHIPPED.md` markers across phases/ and archive/)
- Last artifact (SHIPPED/REVIEW/SUMMARY/PLAN/CONTEXT) + 1-line headline
- Ralph loop state + todos backlog count (when present)
- Last commit + commits today
- Next step (the exact command to run)

Useful for resuming a session after a break.

## Migration

### `/jdi-migrate-phases [--dry-run] [--force]`

Non-destructive upgrade from v1 (numeric IDs) → v2 (slug-as-ID). Idempotent.

```
/jdi-migrate-phases --dry-run    # shows plan, writes nothing
/jdi-migrate-phases              # confirms + writes
```

Does:
1. Validation: `.jdi/ROADMAP.md` exists (STATE.md regenerated if absent); clean working tree in `.jdi/` (or `--force`)
2. Detects `schema_version` — already v2 → exit 0 (no-op)
3. **Audit (always, even with --force)** before any write:
   - **C1** — Folder/ROADMAP parity (folder slug == ROADMAP slug)
   - **C2** — No duplicate canonical slugs (`01-foo/` AND `foo/` = corrupt)
   - **C3** — All existing slugs pass shape validation (`npx -y jdi-cli validate-slug`)
   - **C4** — Orphan folders without a ROADMAP entry → warn (does not block)
4. Shows the plan (always — dry-run or not): schema 1 → 2, N phases, M folders preserved
5. AskUserQuestion confirms (skipped on --dry-run)
6. Updates STATE.md: `schema_version: 2` + `current_phase_slug: <resolved>` (the integer `current_phase` stays as a display mirror). **No manifest file is written** — the resolver finds phases by walking ROADMAP.md + the filesystem
7. Commit: `chore(jdi): migrate to schema v2 (slug-as-ID)`

**Invariant:** existing folders are never renamed. Git history references preserved. One-way (no rollback); re-running on v2 is a no-op.

## Meta command

### `/jdi-create [description]`

Creates a new GENERIC agent or skill in `core/`. Only runs inside the JDI source repo.

```
/jdi-create "specialist for Rust with cargo + clippy"
/jdi-create "skill with EF Core 9 conventions"
/jdi-create
```

Does:
1. Validation — contributor-only guard: `package.json` must declare `"name": "jdi-cli"` AND `core/agents/jdi-architect.md` must exist (a consumer project that happens to have a `core/` folder never passes). Requires clean `core/`
2. Spawns `jdi-architect` in `create` mode:
   - 8 questions (problem, trigger, input, output, reuse, decision-loop, cost, tools)
   - Automatic classification (agent / skill / composite)
   - Validation with the user (approve / edit / cancel)
   - Generates files in `core/agents/` or `core/skills/`
   - Updates routing
3. Build + install for the active runtime
4. Commit + audit in `.jdi/registry.md`

**NOT used in projects consuming JDI.** Only for contributors extending the core.

## Visual summary

```
/jdi-new                  --> .jdi/{PROJECT,ROADMAP,STATE,DECISIONS}.md + config.json + .gitattributes (schema v2)
/jdi-adopt                --> same as /jdi-new but for existing code (adopted: true + D-2 boundary)
/jdi-bootstrap            --> .jdi/agents/{jdi-doer-{slug},jdi-reviewer-{slug}}.md + routing
/jdi-discuss <slug>       --> .jdi/phases/<slug>/CONTEXT.md
/jdi-plan    <slug>       --> .jdi/phases/<slug>/PLAN.md
/jdi-do      <slug>       --> atomic commits + .jdi/phases/<slug>/SUMMARY.md
/jdi-verify  <slug>       --> .jdi/phases/<slug>/REVIEW.md (recreated per run)
/jdi-confirm-dod <slug>   --> REVIEW.md DoD rows flipped (CONFIRMED/REJECTED) + verdict recomputed
/jdi-loop    <slug>       --> ralph mode: do<->verify auto + .jdi/phases/<slug>/LOOP.md
/jdi-ship    <slug>       --> .jdi/phases/<slug>/SHIPPED.md + STATE advance + tag (optional)

/jdi-add-phase "<name>"   --> registers new phase (slug-as-ID, multi-dev safe)
/jdi-remove-phase <slug>  --> removes future/pending phase + archives artifacts
/jdi-status               --> read-only snapshot (no agent, status derived from artifacts)
/jdi-migrate-phases       --> v1 → v2 non-destructive upgrade

/jdi-create               --> [internal] core/agents/* or core/skills/* (JDI source repo only)
```

On v2 (the default for new projects), folders are `.jdi/phases/<slug>/`. On preserved v1 legacy, folders stay `.jdi/phases/NN-<slug>/` — the resolver detects both.

## Global flags

- `--auto` (on `/jdi-discuss`): asker decides everything, no questions
- `--review` (on `/jdi-plan`): shows PLAN preview, asks approval
- `--sequential` (on `/jdi-do`): forces sequential execution even if waves allow parallel
- `--max-iter=N` (on `/jdi-loop`): max iter per round before the human gate (default 5)
- `--max-resets=N` (on `/jdi-loop`): max reset rounds before the kill switch (default 3)
- `--reset-loop` (on `/jdi-loop`): recover a `killed` loop — confirmed, archives the old LOOP.md as audit, starts fresh
- `--reset` (on `/jdi-new`): wipes `.jdi/` before starting (CAUTION)
- `--goal "<text>"` (on `/jdi-add-phase`): phase goal (asked interactively if missing)
- `--slug <slug>` (on `/jdi-add-phase`): overrides the slug derived from the name
- `--before <slug>` / `--after <slug>` (on `/jdi-add-phase`): positional insert without cross-branch race conditions (replaces `--at <int>` on v2)
- `--reason "<text>"` (on `/jdi-add-phase`): audit entry in DECISIONS.md
- `--force` (on `/jdi-remove-phase`): allows removal with artifacts (archives them)
- `--dry-run` (on `/jdi-migrate-phases`): shows plan, writes nothing
- `--force` (on `/jdi-migrate-phases`): bypasses the clean-tree gate (audit C1-C3 always runs)
- `--githooks` (on `jdi install`, CLI): opt-in copy of no-op hooks to `.githooks/` — by default no shell scripts land in your repo

## Idempotency

All commands are idempotent on rerun:
- `/jdi-discuss` with existing CONTEXT.md -> asks overwrite/skip
- `/jdi-plan` with existing PLAN.md -> regenerates (warn)
- `/jdi-do` with completed tasks -> skips them
- `/jdi-verify` -> always recreates REVIEW.md from scratch (previous runs live in git history)
- `/jdi-confirm-dod` -> skips items already confirmed/rejected, resumes at skipped ones
- `/jdi-loop` with LOOP.md status=converged -> aborts (run /jdi-ship); status=running -> resumes; status=killed -> aborts (human review; `--reset-loop` to recover); status=escalated/paused -> resumes with a new round (consumes a reset)
- `/jdi-ship` with SHIPPED.md already present -> already shipped, exit 0
