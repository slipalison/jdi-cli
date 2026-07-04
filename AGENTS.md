# JDI — Agents

6 core agents (shipped) + 2 per-project specialists per stack (generated).

## Core (in `core/agents/`)

### `jdi-researcher` (Opus)

**Role:** Project discovery before the roadmap + captures the project-wide DoD baseline. Greenfield entry point.

**Spawned by:** `/jdi-new`

**Philosophy:** 1 single agent instead of several parallel researchers. Cheaper, sufficient for small/medium projects.

**Inputs:**
- Free-form argument: project idea
- Read in current directory
- Reference: `core/templates/dod-schema.md`

**Outputs:**
- `.jdi/PROJECT.md` (vision + stack + code-design LOCKED + `## Definition of Done` LOCKED)
- `.jdi/ROADMAP.md` (1 phase per MVP feature; no status lines — status is derived from phase artifacts)
- `.jdi/STATE.md`
- `.jdi/DECISIONS.md` (with D-1)
- `.gitattributes` (normalizes line endings)

**Stages:**
- **Step 2 — key questions** (vision, stack, code-design, MVP features, optional Q5 LLM provider)
- **Step 3.5 — DoD baseline:** proposes 5 project-wide candidates (test command, coverage threshold, no-TODO, CHANGELOG, README), per-item keep/edit/drop/replace, free-add cap 8

**DoD baseline rules:**
- Vague items rejected (no `Verify:` field, no pass)
- Cap 8 items in PROJECT § DoD (project-wide invariants only)
- No "convert to D-XX" option (DECISIONS.md only has D-1 at this point)

**Permissions:** Read, Write, Bash, Grep, Glob, AskUserQuestion, WebSearch/WebFetch (max 2 lookups via ctx7).

### `jdi-adopter` (Opus)

**Role:** Adopt mode for **brownfield** projects — code already exists, JDI is added later. Replaces `/jdi-new` for existing codebases.

**Spawned by:** `/jdi-adopt`

**Differences from `jdi-researcher` (greenfield):**
- Does NOT invent the stack — detects it from the repo (manifests, layout, git log, docs)
- Does NOT choose the code design — infers from directory signals (DDD / Vertical Slice / Clean / Hexagonal / The Method / legacy-mixed) and confirms with the user
- Does NOT generate an MVP roadmap — asks which features to **add** (existing code is context, not TODO)
- Writes `adopted: true` in STATE.md so bootstrap/reviewer respect legacy code

**Inputs:**
- (optional) free-form argument: short project description override
- Recursive Read in current directory (manifests, layout, README)
- `git log` if it is a repo (commit-style detection)

**Outputs:**
- `.jdi/PROJECT.md` (with populated `## Existing assets` section, grouped by directory)
- `.jdi/ROADMAP.md` (`adopted: true`; only NEW features become phases)
- `.jdi/STATE.md` (`adopted: true`)
- `.jdi/DECISIONS.md` — **D-1**: code design (detected + confirmed), **D-2**: adopted boundary — records the current commit hash; coverage (80%) is enforced ONLY on files created after that commit, legacy code is not enforced
- `.gitattributes` (only if absent)
- Commit `chore(jdi): adopt {name} brownfield`

**Rules:**
- Max 5 questions, max 2 web lookups
- Code design ALWAYS requires explicit confirmation
- Never refactors existing code — adopt only reads and writes into `.jdi/`
- Existing assets grouped by top-2-level directory, max 30 entries

**Permissions:** Read, Write, Bash, Grep, Glob, AskUserQuestion, WebSearch/WebFetch.

### `jdi-bootstrap` (Sonnet)

**Role:** Wrapper that fires `jdi-architect` in specialist mode to generate doer + reviewer per project.

**Spawned by:** `/jdi-bootstrap`

**Inputs:**
- Read on `.jdi/PROJECT.md`

**Outputs:**
- `.jdi/agents/jdi-doer-{slug}.md`
- `.jdi/agents/jdi-reviewer-{slug}.md`
- `.jdi/specialists.md` + `.jdi/reviewers.md` (routing)
- `.jdi/registry.md` (R-1 audit trail)
- `.jdi/STATE.md` updated (`specialists_ready: true`)

**Multi-stack (Step 2.7):** auto-detects fullstack projects from PROJECT.md (dual-stack patterns like backend + frontend) and offers N specialist pairs, each with a `stack_label` + `file_glob` (e.g. backend `**/*.{cs,csproj,sln}` + frontend `**/*.{ts,tsx,css}`). Single-stack (1 pair) remains the default for ~90% of projects.

**Permissions:** Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Agent (spawn architect), WebSearch/WebFetch.

### `jdi-asker` (Sonnet)

**Role:** Interactive two-stage loop — captures locked decisions + the phase's Definition of Done.

**Spawned by:** `/jdi-discuss <slug|position>`

**Inputs:**
- `phase_id`
- Read on PROJECT.md (incl. § DoD), ROADMAP.md, DECISIONS.md, up to 2 previous CONTEXT.md files
- Reference: `core/templates/dod-schema.md`

**Outputs:**
- `.jdi/phases/<slug>/CONTEXT.md` (includes `## Definition of Done`)
- `.jdi/DECISIONS.md` (append D-XX — schema v2 uses collision-free `D-{YYYY-MM-DD}-{phase_slug}-{seq}` IDs)
- `.jdi/todos.md` (if scope creep)

**Stages:**
- **Stage 1 — Decisions:** identifies 3-5 specific gray areas, max 5 questions, each answer becomes a D-XX
- **Stage 2 — DoD:** proposes 5 candidates derived from D-XX + phase-type templates, per-item keep/edit/drop/replace, free-add cap 10

**Rules:**
- Max 5 questions in Stage 1, max 5 D-XX per session
- Stage 2 mandatory — every phase ships with a declared DoD
- Every DoD item requires `Verify:` (command OR "human confirmation required")
- Vague items rejected at capture (offers reformulate/drop/convert-to-D-XX)
- Identifies specific gray areas (not generic categories)
- Stops when user says "enough" / "go" / 5 questions (Stage 1) or "done" (Stage 2)

**Permissions:** Read, Write, Grep, Glob, AskUserQuestion, WebSearch/WebFetch.

### `jdi-planner` (Opus)

**Role:** Decomposes a phase into tasks with parallelism waves.

**Spawned by:** `/jdi-plan <slug|position>`

**Inputs:**
- `phase_id`
- Read on PROJECT.md, ROADMAP.md, DECISIONS.md, CONTEXT.md, doer specialist(s)
- Read on existing code (mapping `files_modified`)

**Outputs:**
- `.jdi/phases/<slug>/PLAN.md`

**Rules:**
- Max 8 tasks per phase (split if it exceeds)
- Every task has: `files_modified`, measurable `acceptance`, `dependencies`, `test`, `specialist` (auto-assigned via file-glob match against `.jdi/specialists.md` — tasks spanning 2+ specialists are split)
- Wave grouping: parallel within, sequential between
- `files_modified` disjoint within the same wave (overlap = automatic sequential)
- Self-check before saving (5-item checklist)

**Permissions:** Read, Write, Grep, Glob, AskUserQuestion (only if ambiguous), WebSearch/WebFetch.

### `jdi-architect` (Opus)

**Role:** Meta-agent. 2 modes.

**`create` mode (spawned by `/jdi-create`):**
- Creates a GENERIC agent or skill in `core/agents/` or `core/skills/`
- 8 questions to classify (agent / skill / composite)
- Validation with user (approve / edit / cancel)
- Build + install for the runtime
- Only runs inside the jdi-cli source repo (`/jdi-create` guards on `package.json` name == `jdi-cli`)

**`specialist` mode (spawned by `/jdi-bootstrap`):**
- Creates doer + reviewer PER PROJECT in `.jdi/agents/` (one pair per stack for multi-stack projects)
- 6 focused questions (test framework, build/test commands, coverage min, lint, conventions)
- Substitutes placeholders in the `core/templates/{doer,reviewer}-specialist.md` templates
- Maps bash<->PowerShell for the reviewer's gates

**Inputs:**
- `create` mode: optional free-form argument
- `specialist` mode: `.jdi/PROJECT.md` required
- Read on all routing files (`specialists.md`, `reviewers.md`, `skills-registry.md`, `registry.md`)

**Outputs:**
- `create` mode: `core/agents/jdi-{name}.md` or `core/skills/{name}/`
- `specialist` mode: `.jdi/agents/jdi-{doer,reviewer}-{slug}.md`
- Both: routing updates + audit in `.jdi/registry.md` (and `.jdi/skills-registry.md` for skills)

**Permissions:** Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, WebSearch/WebFetch.

## Per-project (in `.jdi/agents/`)

### `jdi-doer-{slug}` (Sonnet)

**Role:** Executor that ALREADY KNOWS the project's stack/code-design/conventions.

**Spawned by:** `/jdi-do <slug|position>`

**Philosophy:** 1 focused specialist that already knows the stack, instead of separate executor + code-fixer + doc-writer.

**Inputs:**
- `phase_id`
- Read on PROJECT.md, DECISIONS.md, CONTEXT.md, PLAN.md
- Write on the paths in the PLAN's `files_modified`

**Outputs:**
- Modified code, committed atomically
- `.jdi/phases/<slug>/PLAN.md` updated (task statuses)
- `.jdi/phases/<slug>/SUMMARY.md` at the end

**Rules:**
- No `--no-verify` on commits (hooks run)
- No skipping tests — a task only completes if its test passed
- Atomic commit per task
- Conventional Commits, scope = phase slug
- Max 3 correction attempts per task before marking `blocked`
- Multi-stack: only touches files matching its `file_glob`; out-of-scope paths → `blocked: out-of-scope` (orchestrator re-routes)

**Permissions:** Read, Write, Edit, Bash. No Web by default (must already know the stack).

### `jdi-reviewer-{slug}` (Sonnet)

**Role:** Runs the quality gates defined for the stack.

**Spawned by:** `/jdi-verify <slug|position>`

**Philosophy:** 1 focused reviewer per stack, instead of separate code-reviewer + security-auditor + integration-checker + verifier.

**Inputs:**
- `phase_id`
- Read on PROJECT.md, PLAN.md, SUMMARY.md, modified code

**Outputs:**
- `.jdi/phases/<slug>/REVIEW.md` with verdict (multi-stack: each reviewer appends its own segment; aggregate = worst case)

**Gates:**
1. Build
2. Tests
3. Coverage (>= PROJECT.md threshold, default 80%)
4. Lint/Format
5. Security/Perf rules for the stack (no secrets, no TODO without issue, no localStorage tokens, etc)
6. Plan consistency (commits match files_modified)
7. UI Validation (conditional — only if `frontend.has_frontend: true`)
8. Definition of Done — parses `PROJECT.md § DoD` + `CONTEXT.md § DoD`, runs `Verify:` per item, classifies Auto PASS/FAIL and Manual MANUAL_REQUIRED

**Verdicts:**
- APPROVED — all PASS, no pending manual DoD
- APPROVED_WITH_WARNINGS — no blockers, with warns, no pending manual DoD
- **APPROVED_PENDING_MANUAL** — gates 1-7 OK, DoD Auto PASS, Manual items awaiting `/jdi-confirm-dod`
- BLOCKED — gate 1-3 failed OR gate 5 critical OR gate 8 with Auto FAIL OR gate 7 BLOCK

**Permissions:** Read-only by design. Read + Bash (only to run gate commands). **No Write, no Edit.**

**Gate 8 hard rules:**
- Never modifies DoD blocks (PROJECT.md/CONTEXT.md are LOCKED)
- Never auto-confirms Manual items (`/jdi-confirm-dod` is the only path — it flips DoD Checklist rows to `CONFIRMED` or `REJECTED`; a `REJECTED` row is an audited waiver and does not block ship)
- PROJECT § DoD applies to EVERY phase (inherited automatically)

## Visual summary

```
core/agents/                  <- 6 agents shipped
  jdi-researcher    Opus     pre-roadmap discovery (greenfield)
  jdi-adopter       Opus     brownfield adoption (detect + confirm)
  jdi-bootstrap     Sonnet   wrapper -> spawn architect specialist mode
  jdi-asker         Sonnet   question loop (decisions + DoD)
  jdi-planner       Opus     decompose phase into waves
  jdi-architect     Opus     meta (create + specialist modes)

.jdi/agents/                  <- per-project, generated by /jdi-bootstrap
  jdi-doer-{slug}     Sonnet  specialist executor (1 per stack)
  jdi-reviewer-{slug} Sonnet  specialist reviewer (read-only, 1 per stack)
```

## Models per runtime

Each agent declares `runtime_overrides:` in its frontmatter. The build script generates runtime-specific frontmatter:

| Runtime | Field | Example (researcher) |
|---|---|---|
| Claude Code | `model:` | `opus` |
| GitHub Copilot | `model:` | `gpt-5` |
| Antigravity | `triggers:` | automatic discovery via `jdi-` prefix |
| OpenCode | `mode:`, `model:`, `temperature:`, `permission:` | `subagent`, `anthropic/claude-sonnet-4-20250514`, `0.2`, edit/bash/write rules |

## Extending

To create a new core agent: run `/jdi-create` inside the JDI source repo (guarded — `package.json` name must be `jdi-cli`). Architect create mode does everything.

**Multi-stack is native.** `/jdi-bootstrap` Step 2.7 detects fullstack projects and generates N doer/reviewer pairs, each scoped by `file_glob`. `/jdi-plan` assigns each task a `**Specialist:**` via glob match, `/jdi-do` dispatches each task to its specialist (different specialists may run in parallel within a wave on disjoint files), and `/jdi-verify` chains the reviewers sequentially with worst-case verdict aggregation. To change the setup later (a new stack enters the project), re-run `/jdi-bootstrap` (idempotent — detects existing specialists and asks Recreate / Keep / Cancel) or edit `.jdi/agents/` + `.jdi/specialists.md` manually.
