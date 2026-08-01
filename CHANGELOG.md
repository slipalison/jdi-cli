# Changelog

All notable changes to `jdi-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.0] - 2026-08-01

Conflict-free layout v3. A real two-branch PR (TranslateReader #15) conflicted
on `.jdi/DECISIONS.md`, `.jdi/ROADMAP.md` and `.jdi/todos.md` **despite every
file carrying `merge=union`** — reproduced locally: the merge is clean with
the attribute and conflicts without it, and GitHub/GitLab/ADO server-side PR
merges IGNORE `.gitattributes` merge drivers (Kubernetes dropped union for
the same reason, kubernetes/kubernetes#70576). The declared "zero merge
conflicts by construction" invariant only ever held for local CLI merges.
0.13.0 rebuilds the guarantee structurally: **one file = one writer** —
38 assertions across 10 two-dev merge scenarios (plain 3-way, exactly GitHub
semantics) pass with zero conflicts.

### Added
- **Per-entry state layout (v3).** Every multi-writer stream becomes a
  directory of single-writer files: roadmap → `.jdi/roadmap/{slug}.md`
  (`order:` frontmatter, fractional on insert-between — no sibling renumber),
  decisions → `.jdi/decisions/D-{date}-{slug}-{seq}.md` (filename = ID),
  todos → `.jdi/todos/{date}-{slug}.md`, bootstrap//jdi-create output →
  `.jdi/registry/R-{date}-{slug}.md` (fenced `<!-- jdi:... -->` sections).
  Different branches write different files — nothing to conflict on any
  platform, no git configuration needed.
- **`jdi-cli render`** — regenerates the old single-file paths (ROADMAP.md,
  DECISIONS.md, todos.md, registry.md, specialists.md, reviewers.md,
  skills-registry.md) as **untracked views** in the exact legacy format, so
  every reader (agents, greps, humans, prompt-cache prefixes) keeps working
  unchanged. Byte-deterministic across the `.sh` and `.ps1` renderers
  (LF-normalized, ordinal sort, CRLF-tolerant parsing). `--check` reports
  drift/warnings for doctor/CI. Every state-reading command refreshes the
  views at Step 1.
- **`jdi-cli migrate-layout`** — one-time, idempotent, deterministic migration
  for existing projects: splits ROADMAP.md into `roadmap/` (header/footer
  sections preserved; heals out-of-order phase numbering), freezes
  DECISIONS.md/todos.md/registry tables as `LEGACY*` files via `git mv`
  (history and every `D-N` reference stay valid), untracks + gitignores the
  views, renders, stages (does not commit). Folds in the 0.3.0 STATE.md
  untracking. Views concatenate LEGACY + new entries — readers see one
  continuous file. Verified against a real 136K-decision brownfield repo:
  phase/header/decision fidelity byte-checked, sh↔ps1 migrations
  byte-identical.
- **Gate: views/LEGACY are never committed.** The pre-commit hook and
  `jdi-artifacts-gate.yml` fail any commit/PR that tracks a view or edits a
  frozen LEGACY file, printing the per-entry fix. Doctor gains a layout
  section: v3 → checks views untracked + in sync (`render --check`); legacy →
  WARN with the migration command.
- Concurrent `add-phase` picking the same `order` merges cleanly and renders
  as a duplicate-order warning with a stable slug tie-break — a warning
  instead of a conflict. Deliberate conflicts stay visible by design:
  PROJECT.md/config.json edits and remove-phase racing someone's work
  (modify/delete on the phase's own files).

### Changed
- `/jdi-new` and `/jdi-adopt` initialize the v3 layout natively and write a
  `.gitattributes` with **no `merge=union` lines** (line-ending normalization
  only) — v3 needs no merge driver. Init decisions keep literal `D-1`/`D-2`
  filenames (written once, pre-branching), so the adopt verification and the
  architect boundary grep work unchanged against the rendered view.
- `/jdi-add-phase`, `/jdi-remove-phase`, `/jdi-discuss` (asker),
  `/jdi-bootstrap` + `/jdi-create` (architect) branch on layout: v3 writes
  per-entry files + render; legacy keeps the old appends. `/jdi-ship` and
  `/jdi-remove-phase` stop writing `archive/index.md` on v3 (the archive dir
  listing IS the index; the file stays as frozen history on legacy projects).
- `resolve-phase` and `validate-slug` (`.sh` + `.ps1`) read `.jdi/roadmap/`
  as the source of truth when present (position = rank by `order` asc, slug
  asc; emitted `JDI_PHASE_SCHEMA=3`) and never parse the possibly-stale
  rendered view; legacy single-file parsing is unchanged (full dual-read
  back-compat — unmigrated projects keep working exactly as before).
- `/jdi-migrate-phases` no longer aborts on a fresh clone (STATE.md is
  gitignored — it now regenerates the minimal fields like add/remove-phase
  do) and documents that the FILE-LAYOUT migration is `migrate-layout`, a
  separate deterministic command.
- `bin/jdi.js`: new `render` and `migrate-layout` subcommands; GNU-style
  `--flags` for these are mapped to PowerShell `-PascalCase` parameters at
  the dispatch boundary.

## [0.12.1] - 2026-07-23

Packaging hotfix for the 0.12.0 delegated-agent surface. First real adopter
(`blip-ai/blip-solution-dashboard` PR #9) hit three defects that made the
headline feature broken on any clean Linux environment. All three verified
against the code before fixing (the reporting issue was AI-authored — each
claim was reproduced, not trusted).

### Fixed
- **Every shell script shipped without the exec bit** (all 14 `.sh` + both git
  hooks were git mode `100644`). npm preserves git file modes, so the 0.12.0
  tarball was non-executable. Two load-bearing surfaces bypass the
  `bash <script>` wrapper in `bin/jdi.js` and broke: (1) `validate-phase`, the
  only script-to-script **direct exec**, died with `Permission denied` — then
  the `||` swallowed it and misreported "phase not found in ROADMAP.md"; (2)
  installed git hooks in a fresh consumer clone were **silently ignored** (git
  skips non-executable hooks with only an invisible hint), so the in-session
  artifact gate never fired. Fixed at the root with `git update-index
  --chmod=+x` on all scripts + hooks (the publish runs on Linux CI, which
  materializes the bit into the tarball), plus defense in depth: `validate-phase`
  now invokes the resolver via `bash <path>` (mode-independent, consistent with
  `bin/jdi.js`) and distinguishes "resolver could not run" from "phase not
  found". A new **publish guard** fails the release if any tracked `.sh`/hook
  regresses to `100644`.
- **`jdi-artifacts-gate.yml` could not diff `HEAD^1`.** `actions/checkout@v4`
  defaults to `fetch-depth: 1` (shallow); on a `pull_request` the checkout is
  the merge commit, so `HEAD^1`'s tree is absent and `git diff HEAD^1 HEAD`
  failed — the merge-point gate went red on the exact compliant `copilot/*`
  PRs it should pass. Pinned to `fetch-depth: 2` (minimal correct depth for a
  first-parent diff of a merge commit). *(Reported via Copilot's own review on
  the adopter PR.)*
- **The pre-commit hook and the CI gate used different glob semantics** for
  `gate.code_globs`. The hook collapsed `**`→`*` into a bash `case` (single `*`
  crosses `/`); the workflow's `glob_to_re` mapped `*`→`[^/]*` (does not cross).
  They agreed on the default `src/**` but diverged on any single-`*` segment
  (e.g. `src/*/*.cs`) — a hole in the two-red-lights design where the
  in-session and merge-point gates could disagree about whether a change
  "touches code". The hook now uses the **same `glob_to_re` + `grep -E`** as the
  workflow (kept byte-identical, cross-referenced in comments). *(Reported via
  Copilot's own review on the adopter PR.)*

### Added
- **doctor §13**: warns when `.githooks/pre-commit` exists but is **not
  executable** (the silent-gate-off case).

## [0.12.0] - 2026-07-22

Delegated-agent hardening. Field report (Linear → GitHub Copilot coding agent
→ `/jdi-issue`): the delegated session auto-selected the WRONG persona
(`jdi-asker` — no terminal, "do not implement"), ran zero gates, and the
harness silently dropped the one artifact it did create (`report_progress`
only auto-commits tracked files). Root cause is structural: a delegated
coding-agent session is a distinct runtime surface (single semantic-selected
persona, headless, no sub-agents, CI silent until approved) that JDI did not
model — and every JDI requirement was prose, which agents optimize away.
Answer in three layers: a correct persona to select, a red light inside the
session, a red light at the merge point.

### Added
- **`jdi-solo` — 7th core agent**: end-to-end solo executor for delegated and
  headless sessions. Plays every JDI role inline in sequence (asker → planner
  → doer → reviewer → shipper) following the INSTALLED command processes with
  declared solo deviations: loop caps intact with AUTO-RESET, self-critic
  replacing the spawned DoD critic (tighten-only), checkpoint commit per
  artifact, explicit `git add` + index verification per `.jdi/` file
  (harness-drop defense), budget-squeeze protocol (artifacts are never the
  thing you skip), hard preflight (no terminal → STOP and report). Built for
  all 5 runtimes; on Copilot it ships with no `tools:` restriction (full
  toolset, terminal included).
- **`validate-phase` CLI subcommand** (`bin/lib/jdi-validate-phase.{sh,ps1}`,
  byte-mirrored): the derived-status contract made executable. Validates
  presence AND minimal structure of CONTEXT/PLAN/SUMMARY/REVIEW/SHIPPED
  (DoD with `Verify:`, tasks with Files modified/Acceptance/Dependencies/Test,
  verdict line, ship marker). `--for-pr` = full-chain gate (all 5 + verdict
  APPROVED/APPROVED_WITH_WARNINGS). One implementation consumed by CI, agents
  and humans.
- **Coding-agent workflows** shipped by `install copilot` (never overwriting
  existing files): `copilot-setup-steps.yml` (Node 20 + activates
  `.githooks/` inside the agent's environment; must live on the default
  branch) and `jdi-artifacts-gate.yml` (PRs from `copilot/*` touching code
  fail without the complete artifact chain — runs `validate-phase --for-pr`
  per touched phase; code paths configurable via `gate.code_globs` in
  `.jdi/config.json`, default `src/**`).
- **doctor section 13 — coding-agent readiness**: jdi-solo present, both
  workflows present, pre-commit gate active in `.githooks/`.
- **README § "Delegated issues"**: setup, delegation from Linear/GitHub/CLI,
  what a compliant PR looks like, troubleshooting (wrong persona, dropped
  artifacts, firewall), headless-runner alternative.

### Changed
- **`bin/git-hooks/pre-commit` is no longer a no-op**: it is the JDI
  phase-artifact gate. A commit touching code globs without an ACTIVE phase
  (CONTEXT.md + PLAN.md staged/tracked, no SHIPPED.md) in the git INDEX fails
  with the exact fix (including the `git add .jdi/phases/<slug>/` case when
  artifacts exist only on disk). Still opt-in via `--githooks`; humans can
  bypass with `JDI_GATE_DISABLE=1` or `--no-verify`; delegated agents must
  not.
- **Anti-selection disclaimers** on the six orchestration agents
  (researcher, adopter, bootstrap, asker, planner, architect): their
  descriptions now state they are internal sub-agents and point delegated
  sessions to `jdi-solo` — descriptions are the selection surface for
  Copilot's engine (and Junie/Antigravity semantic discovery).
- **`/jdi-issue` runtime notes** split Copilot into interactive vs coding
  agent (delegated), documenting the jdi-solo path, the two mechanical gates,
  the "Approve and run workflows" requirement, and the headless-runner
  fallback for maximum fidelity.
- **PORTABILITY.md**: new "Copilot is THREE surfaces" section + capability
  degradation matrix (no spawn → solo protocol; no terminal → hard stop; no
  human → auto mode with caps; unreliable persistence → index-validated
  artifacts; no CI visibility → in-session hook).

## [0.11.0] - 2026-07-11

Team hotfix: user-reported (correctly) that ROADMAP.md changes on every new
phase and conflicts under parallel developers. The 0.7.0 assessment ("roadmap
mutation is a rare planning event, visible conflict acceptable") was
invalidated by 0.8.0's `/jdi-issue`, which made phase appends a per-card
operation.

### Fixed
- **`total_phases` is no longer stored in ROADMAP.md** (new projects). A stored counter conflicts on EVERY parallel add and — worse — union-merges to a stale number. The count is derived from `### Phase ` headings everywhere (`/jdi-status` now counts headings directly, never trusting a possibly-stale legacy line). Legacy ROADMAPs keep their line, updated best-effort by add/remove-phase.
- **ROADMAP.md now carries `merge=union`** in the generated `.gitattributes` (researcher + adopter, with a separate idempotent guard so existing projects pick it up on re-adopt/update). Parallel `/jdi-issue`/`add-phase` appends auto-merge. Documented trade-off (rare, recoverable, audited): a `remove-phase` racing a merge can resurrect the removed block — `/jdi-status` shows it, `D-{date}-{slug}-rm` in DECISIONS.md audits it, re-running the remove fixes it; remove-phase now documents this post-merge hygiene.
- Mid-roadmap inserts (`--before`/`--after`) at the same spot on two branches may still conflict — deliberate (planning events belong on an up-to-date branch).

Migration for existing projects: `echo '.jdi/ROADMAP.md merge=union' >> .gitattributes` (and optionally delete the `total_phases:` line from ROADMAP.md).

## [0.10.1] - 2026-07-11

### Fixed
- **SonarCloud quality gate on PR #17 failed and the merge raced past it** (chained command did not stop on the failing check — process error, documented here for the record). Two findings, both addressed: (1) `bin/jdi-build.sh` used the literal `'copilot'` 5x — extracted `RT_COPILOT` (same S1192 class as 0.2.0's `RT_CLAUDE`; builder re-EXECUTED after the change, 0 drift); (2) new-code duplication 5.2% came from `runtimes/copilot/skills/` duplicating the prompt files — that is build output duplicated by construction (one source, five generated adapters), now excluded from duplication measurement via `.sonarcloud.properties` (`sonar.cpd.exclusions=runtimes/**`). Duplication stays measured on real sources.

## [0.10.0] - 2026-07-11

### Fixed
- **Copilot CLI could not see any JDI command.** Root cause: the CLI does not read `.github/prompts/*.prompt.md` — that discovery path is VS-Code-only (upstream feature requests github/copilot-cli#618 and #1113 are still open). JDI's Copilot adapter predated the CLI. Fix: the builder now also emits every command and standalone skill as **Agent Skills** (`runtimes/copilot/skills/<n>/SKILL.md` — GA on Copilot since Apr/2026), and `jdi install copilot` writes them to `.github/skills/`, which **all three Copilot surfaces** discover: the CLI, VS Code agent mode, and the github.com coding agent. Prompt files stay (VS Code `/` menu); agents stay (`.github/agents/`, read by CLI + coding agent). After updating: `npx jdi-cli@latest install copilot`, then `/skills reload` in the CLI session and type the command in the message ("/jdi-status"). `doctor` now checks `.github/skills/` and flags a prompts-without-skills install with a fix hint; `uninstall` cleans the new dir.

## [0.9.0] - 2026-07-11

### Added
- **JetBrains Junie (CLI) — 5th runtime, tier 1.** `jdi install junie` (also included in `install all`). Mapping: JDI commands ship as Junie **skills** (`.junie/skills/<n>/SKILL.md`, semantic discovery — Junie custom commands were rejected on purpose: their named template arguments are all-mandatory and would treat the `$VARS` inside command bodies as parameters); core agents ship as **subagents** (`.junie/agents/<n>.md`) with **enforced** tool allowlists derived from the claude override filtered to Junie's tool set (the reviewer is genuinely read-only on this runtime) and `reasoningLevel` mapped from `runtime_intent.reasoning`; guidelines in `.junie/AGENTS.md`. No model is ever emitted — Junie is LLM-agnostic and inherits the user's choice. Project installs copy bootstrap-generated specialists from `.jdi/agents/` into `.junie/agents/` (Junie delegates by description match); re-run the install after `/jdi-bootstrap`. `update`/`uninstall`/`doctor` cover the new runtime; Playwright MCP on Junie is manual (`mcp-locations` in `~/.junie/config.json` — path conventions not yet documented upstream).

## [0.8.0] - 2026-07-11

### Added
- **`/jdi-issue` — autonomous intake (17th command). Card → PR with no human in the chain.** Reads a task/issue/card through a provider ladder — GitHub URL via `gh`, tracker URL/ID via the provider's MCP tools when connected (Linear, Jira/Atlassian, Azure DevOps, Trello), pasted text as the universal fallback — then chains add-phase → discuss `--auto` (card as primary source: constraints → locked decisions, checklists → DoD) → plan → loop → ship `--pr`. Autonomy is earned by rigor, not by skipping checks:
  - **DoD `auto_only`**: every DoD item must carry an executable `Verify:`; inherently-human criteria are surfaced as `## Deferred to PR review` in the PR body — never silently waived, never MANUAL_REQUIRED (nothing blocks on an absent human).
  - **DoD critic forced on** in every verify when the runtime spawns sub-agents, regardless of `orchestration.mode` (the critic can only tighten).
  - **Warnings get one dedicated fix round** before shipping (stricter than interactive mode's "ship anyway?"); persisting warnings are listed in the PR body.
  - **Loop auto-continues its human gate** (`AUTO-RESET` audited in LOOP.md) but ALL hard fuses stay: max 3 resets / 15 iterations absolute → `killed` = full stop; killed work is never shipped; JDI never merges the PR.
  - The proactive trigger stays outside JDI (CI/webhook invokes the runtime headless) — daemon-free as always.
- Asker `<brief_mode>`: orchestrators can pass `brief=<card>` (external card = primary source) and `dod=auto_only`; `/jdi-verify` accepts `critic=on` from orchestrators.
- **`/jdi-next --loop`** (and per-project `orchestration.next_execution: "loop"` in config.json): on the execute/verify states (`planned`, `executed`, `verified+BLOCKED`), route to `/jdi-loop` instead of single `do`/`verify` steps. Default stays `step` — a next that silently triggers up to 15 iterations would betray its "predictable one step" contract and ralph requires a trustworthy test suite; making loop primary is a per-project decision, not a global default.

## [0.7.0] - 2026-07-11

### Added
- **`/jdi-new --auto` (alias `--yolo`)** — fully autonomous project creation, zero questions. Whatever the description does not answer, the researcher decides itself: context7/web research when available, stack heuristics otherwise; every guessed decision records a 1-line rationale (D-1 reads `auto-locked: <why>`; the DoD baseline keeps the 5 derived candidates without the edit loop). Explicit choices in the description are never overridden, and the destructive `--reset` confirmation is never bypassed. Consistent with the existing `/jdi-discuss --auto`.

### Docs
- **Team usage:** documented the ONE file that can still conflict — ROADMAP.md under simultaneous `add-phase`/`remove-phase` on parallel branches — why it is deliberate (a `merge=union` there could silently resurrect a removed phase), and the trivial resolution (keep both blocks, fix display numbering; slugs never collide). Verified empirically: normal commits and simultaneous DECISIONS.md appends merge clean; only concurrent roadmap mutation conflicts.

## [0.6.0] - 2026-07-11

Antigravity 2.0 support (Google, May 2026 — IDE + `agy` CLI + SDK; replaces
Gemini CLI). The 1.x skill path (`~/.gemini/antigravity/`) is no longer read
by the 2.0 suite, so JDI installs there were invisible to Antigravity 2.0.

### Changed
- **Installer targets the Antigravity 2.0 canonical paths**: project scope → `<root>/.agents/skills/` (tool-agnostic workspace dir, read by IDE + CLI; `agents.md` goes to `.agents/agents.md` instead of polluting the project root); user scope → `~/.gemini/config/skills/` (whole suite). Installing while a 1.x tree exists prints a migration warning.
- **`update` migrates 1.x → 2.0 automatically**: detects legacy `.gemini/antigravity/` trees (project or user), installs into the 2.0 paths and removes the legacy dir (dry-run shows the plan).
- **`uninstall` cleans both generations** — 2.0 paths and legacy 1.x trees, including the root-level `agents.md` from 1.x installs (with confirmation).
- **`doctor` understands generations**: detects the `agy` binary and `~/.gemini/config/` (2.0), still recognizes 1.x, and flags legacy skill trees with a migrate hint; MCP check covers `~/.gemini/config/mcp_config.json` (2.0) and `settings.json` (1.x).
- **`install-playwright` writes the 2.0 MCP file** — user scope auto-detects the generation (`~/.gemini/config/` or `agy` present → `mcp_config.json`; otherwise 1.x `settings.json`). Project scope keeps `.gemini/settings.json` (2.0 documents no project-scope MCP file).

### Notes
- **Skill format is already compatible**: Antigravity 2.0 discovers skills by semantic match on the `description` frontmatter field — JDI descriptions were designed to be specific. The legacy `triggers:` metadata is ignored by 2.0 (harmless); no builder change needed.
- Sources: Antigravity 2.0 docs (antigravity.google/docs/skills), Google codelabs (skills authoring), google/agents-cli#26 (canonical path confirmation).

## [0.5.1] - 2026-07-11

Docs-only: README reorganized around the reader's journey (decide → install →
use → understand → team → features → reference → meta).

### Changed
- **Section order**: "When NOT to use JDI" moved to the top (adoption decision belongs at the door); Quickstart now precedes The flow; the 150-line CLI flag reference moved out of the narrative into the reference block; lifecycle (Update/Uninstall/Reset) grouped; inventories (commands/agents/skills) grouped.
- **Merged** "Multi-developer concurrency" into "Team usage" (they were two sections about the same topic).
- **Deduplicated**: Update/Uninstall example blocks (kept once, in the CLI reference); "Power users" sub-table that repeated the following section verbatim.
- **Fixed stale content**: "Publishing to npm" now documents the real flow (GitHub Release → `release: published` workflow → provenance publish) instead of the old manual-tag flow; Agents inventory model column now reflects 0.4.0 model-agnosticism (runtime default; Claude tier aliases); tagline says solo **or team**; registry example uses 0.3.0 deterministic IDs.

## [0.5.0] - 2026-07-11

Backpressure release — three small changes from a spec-anchored-development
review, filtered hard for fit ("the first no comes from the machine", but only
where JDI already promised it). Explicitly rejected in the same review:
git hooks with teeth (per-clone, bypassable, cross-shell fragility — CI is the
real enforcement), automatic learning promotion (a manual path shipped in
0.4.0 `--stats` and there is no evidence of pain yet), capability specs and
autonomy milestones (enterprise ceremony against JDI's lean thesis).

### Changed
- **Gate 6 now enforces locked decisions (BREAKING for reviewer behavior).** "Locked decisions never reverse" was declared but never verified: the reviewer carried DECISIONS.md in context and checked only plan consistency. Gate 6 now selects the decisions relevant to the phase's changed files and BLOCKS when the diff contradicts one (citing the D-XX and file/line). Suspected-but-unsure contradictions warn. Existing projects pick this up on the next `/jdi-bootstrap` (specialists are generated from templates).
- **Doer runs lint per task.** The task loop is now implement → lint (`{LINT_COMMAND}`, silently skipped when the project has no linter) → test → commit. Lint errors were previously caught only at `/jdi-verify` — a whole extra round for something one edit fixes at the point of writing. The architect fills `{LINT_COMMAND}` in the doer from the same answer used for the reviewer.

### Added
- **"When NOT to use JDI"** section in the README: throwaway prototypes, pure exploration, and drive-by fixes are cheaper without the ceremony — rule of thumb: cost of an error × how long the code will live. Plus a Team-usage note: put the PROJECT.md `test_command` in CI as the deterministic backstop no agent can skip.

## [0.4.0] - 2026-07-11

Adoption + outcomes release, driven by a review against Sierra's enterprise
agent lessons ("AI-pilling our company"): absorb complexity in the tool, not
the user; never pin models the user didn't choose; hand humans judgment calls,
not scavenger hunts; measure outcomes, not activity.

### Added
- **`/jdi-next` — the one command to remember (16th command).** Derives the phase status from artifacts and EXECUTES the correct next step: pending → discuss, discussed → plan, planned → do, executed → verify, verified+BLOCKED → do (fix mode), verified+PENDING_MANUAL → confirm-dod, verified+APPROVED → ship, shipped → next phase. It reads the installed target command file and follows its process — every gate still applies; `/jdi-next` only routes. One step per invocation (unattended iteration remains `/jdi-loop`).
- **`/jdi-status --stats` — outcome metrics, zero telemetry.** First-pass approval rate, average verify rounds, ralph iterations, blocked tasks, median lead time discuss → ship, learnings carried forward — all derived read-only from artifacts + git history, plus an interpretation guide. Activity is not outcome; this answers "is JDI actually helping?".
- **`/jdi-ship --pr`** — after the final commit, push the branch and open a pull request via `gh` with verdict + artifact paths + `§ Learnings` in the body. Best-effort: skips without gh/remote or on the default branch; never fails the ship. (Also fixes `doctor`, which promised PR-opening that ship never did.)
- **DoD suggested evidence.** For each Manual DoD item the reviewer now pre-collects what it FOUND in the repo (read-only, from the item's `Evidence:` hint) into the checklist as `suggested: …`; `/jdi-confirm-dod` surfaces it with a one-click "the reviewer's finding is correct" option. Status never auto-flips — the human always decides; it just stops being a scavenger hunt.

### Changed
- **JDI no longer pins models the user did not choose.** Removed 21 hardcoded `model:` pins from command/agent frontmatter — 13× `anthropic/claude-sonnet-4-20250514` (a dated May-2025 snapshot forced on every OpenCode user) and 8× `gpt-5` (Copilot) — commands and agents now inherit the runtime's configured default. The architect's `{LLM_OPENCODE_MODEL}` fallback no longer hardcodes a snapshot either: with no `llm_config` in PROJECT.md the `model:` line is deleted (runtime default). Claude-runtime tier aliases (`sonnet`/`opus`) are kept — they float with releases and encode intentional cost routing, not a snapshot.

## [0.3.1] - 2026-07-09

### Added
- **README mermaid diagrams** (docs-only release so npmjs.com picks them up): main flow (command → artifact → gate chain, verdict routing, Learnings feedback), ralph-mode state machine (LOOP.md semantics), memory layers by lifespan (long-term / per-phase / routing / untracked STATE cache + read-depth ladder), and a sequence diagram of when each `.jdi/` file is written and read across one phase. All render-validated with mermaid-cli.

## [0.3.0] - 2026-07-09

Zero-merge-conflict guarantee completed + cross-phase learning. Closes the two
gaps a harness-engineering review surfaced: `STATE.md` was still a guaranteed
merge conflict between parallel developers, and failure knowledge died with
its phase.

### Added
- **`SHIPPED.md § Learnings`** — `/jdi-ship` distills REVIEW.md warnings/blockers/waived DoD items + SUMMARY.md blocked tasks into at most 5 one-line bullets (section omitted when nothing qualifies). `jdi-planner` and the doer read the `## Learnings` of the up-to-3 most recently shipped phases and convert recurring items into acceptance criteria — recurring failures stop recurring, at a cost of a few hundred tokens per plan. Team-safe: lives in the phase folder, single writer, no central playbook file.
- **`merge=union` on the append-only `.jdi/` files** (`DECISIONS.md`, `todos.md`, `registry.md`, `specialists.md`, `reviewers.md`, `skills-registry.md`, `archive/index.md`) in the `.gitattributes` generated by `/jdi-new` and `/jdi-adopt` (idempotent append on existing files). Simultaneous appends on two branches now auto-merge instead of conflicting. Deliberately NOT applied to `ROADMAP.md` (a `remove-phase` deletion could silently resurrect on merge), `PROJECT.md`, or `config.json`.
- **Fix mode in the manual flow** — `/jdi-do` on a phase whose tasks are all `completed` but whose `REVIEW.md` says `BLOCKED` (gate failure: coverage, lint, …) now dispatches the doer in fix mode instead of exiting as "already executed". The doer's fix-mode detection no longer requires `LOOP.md`; a BLOCKED review alone triggers it. `/jdi-verify → BLOCKED → /jdi-do` is a real feedback loop outside `/jdi-loop` now.

### Fixed
- **`bin/jdi-build.sh` was dead on arrival in 0.2.0** — the S1192 constant extraction landed as a self-reference (`readonly RT_CLAUDE="$RT_CLAUDE"`), so under `set -u` the script died on line 17 before writing anything. POSIX contributors could not rebuild `runtimes/` (consumers were unaffected — the npm tarball ships pre-built adapters). Both builders re-verified byte-identical after the fix.
- **`resolve-phase` no longer hard-fails when `STATE.md` is absent** — it read STATE.md only for `schema_version`; a missing file now implies v2 (legacy v1 projects always track STATE.md). Required for every command to work on a fresh clone of a 0.3.0 project.

### Changed
- **`STATE.md` is no longer versioned.** It was the last remaining merge hotspot: every command rewrites it, so two developers merging branches conflicted on it every time. `/jdi-new` and `/jdi-adopt` now add `.jdi/STATE.md` to `.gitignore`; commands stage it tolerantly (legacy projects that still track it keep working) and regenerate it from phase artifacts when absent (fresh clone): current phase = first ROADMAP phase without `SHIPPED.md`. `/jdi-status` derives the `next_step` hint from artifacts when the cache is regenerated. Migration for existing projects: `git rm --cached .jdi/STATE.md && echo '.jdi/STATE.md' >> .gitignore`.
- **`registry.md` entry IDs are deterministic** — `R-{YYYY-MM-DD}-{slug}` (was sequential `R-{N}`, racy across branches; same rationale as the 0.2.0 D-ID change). Legacy `R-{N}` entries are accepted on read, never rewritten.

## [0.2.0] - 2026-07-04

Team-oriented hardening. `.jdi/` (including the generated specialists) is now
a shared, git-committed source of truth for a whole team — the release removes
the merge hotspots and fixes the fail-open control paths that made that unsafe.

### Added — Team model
- **Artifact-derived phase status.** Phase status is no longer stored — it is derived from the phase folder's artifacts: `SHIPPED.md` → done, `REVIEW.md` → verified, `SUMMARY.md` → executed, `PLAN.md` → planned, `CONTEXT.md` → discussed, nothing → pending. `/jdi-status` shows the derived status (plus the STATE hint), shipped-phase progress, active ralph-loop state, and the `todos.md` backlog count.
- **`phases/<slug>/SHIPPED.md` marker** (`shipped_at` / `verdict` / `by`) written by `/jdi-ship`. It is the canonical "done" flag and the double-ship guard.
- **Team usage** documentation (README + ARCHITECTURE): shared `.jdi/`, one `/jdi-bootstrap` per team, slugs as stable cross-branch phase identity, one phase per branch/developer.
- **Plumbing subcommands** on the CLI: `npx -y jdi-cli resolve-phase [--json] | validate-slug | truncate | monitor`. Slash commands call these instead of deriving a `bin/lib` path, so the deterministic backbone works in every install topology while keeping the no-code-in-consumer-repo invariant.

### Changed
- **`/jdi-ship` no longer edits `ROADMAP.md`** (only writes `SHIPPED.md` + advances the STATE hint), so two developers shipping different phases on different branches never conflict. Legacy ROADMAPs carrying per-phase `Status:` lines still get a best-effort update.
- **`ROADMAP.md` is append/insert-only.** New projects' ROADMAP has no per-phase `Status:` lines and no `current_phase` pointer; only `/jdi-add-phase` / `/jdi-remove-phase` touch it.
- **`STATE.md` is advisory** — a per-clone next-step hint. Gates check artifacts, never the pointer. `current_phase` stays a plain integer; completion is flagged via `all_phases_complete: true`.
- **Verdict aggregation is worst-case everywhere** (`ship`/`verify`/`loop`/`confirm-dod`): `BLOCKED > APPROVED_PENDING_MANUAL > APPROVED_WITH_WARNINGS > APPROVED`, across every verdict line (multi-stack REVIEW.md has one per reviewer). Empty/unrecognized verdict now aborts instead of shipping; legacy pt-BR `Veredicto:` is accepted.
- **`/jdi-verify` recreates `REVIEW.md` per run** so a stale `BLOCKED` from a previous run can no longer poison the aggregation.
- **DoD confirmation** uses the DoD Checklist table as the single source of truth: `/jdi-confirm-dod` flips each Manual row's Status to `CONFIRMED` (evidence) or `REJECTED` (audited waiver, does not block ship); ship requires zero `MANUAL_REQUIRED` rows remaining.
- **Ralph loop**: resuming from `escalated`/`paused` now consumes a reset (the absolute 15-iteration cap can no longer be bypassed by abort+rerun); `--reset-loop` recovers a `killed` loop (archived to `LOOP.md.killed-{ts}`); `APPROVED_PENDING_MANUAL` exits cleanly to `/jdi-confirm-dod`; oscillation compares against the whole round (catches A/B/A/B); `$DOER`/`$REVIEWER` are actually resolved; every terminal transition commits.
- **Decision IDs** for phase decisions are collision-free `D-{YYYY-MM-DD}-{slug}-{seq}` (genesis `D-1`/`D-2` unchanged).
- **`jdi install` git hooks are opt-in** via `--githooks` / `-Githooks` (default installs no shell into the consumer repo — same invariant as the 0.1.16 update-notifier removal). `jdi uninstall` sweeps orphaned update-notifier hooks left by installs ≤ 0.1.15.
- Gates promised by ARCHITECTURE but previously unchecked are now enforced: `bootstrap→discuss` requires the specialists to exist; `/jdi-new` and `/jdi-discuss` verify their `§ Definition of Done` output; `/jdi-create` guards on `package.json name == jdi-cli` (a consumer repo with its own `core/` no longer passes).

### Removed
- **`phases.json`** — it had four writers and zero readers (the resolver walks `ROADMAP.md` + the filesystem). No longer written by `add`/`remove`/`ship`/`migrate`; existing files are ignored.
- `compaction.keep_phases` from the config template and generators (unused; `archive_after` is the effective knob).

### Fixed
- **Both builders are byte-identical and deterministic.** `jdi-build.sh`'s awk parser had range/frontmatter/trigger-extraction defects that silently diverged from the committed (`.ps1`-built) `runtimes/` — rewritten as frontmatter-bounded helpers mirroring the `.ps1` parser 1:1. `Write-Utf8NoBom` normalizes CRLF→LF. Added `.gitattributes` (LF for `.sh`/`.js`/`.md`, CRLF for `.ps1`) to end the autocrlf ghost-churn of ~110 files per cross-shell build.
- **Non-ASCII in `.ps1` sources.** `bin/jdi.js` spawns Windows PowerShell 5.1, which reads BOM-less files as ANSI; a UTF-8 em dash inside a quoted string in `jdi-monitor.ps1` closed the string early and killed the script at runtime (pwsh 7 AST masked it). Normalized em/en dashes, arrows, curly quotes, and ellipses to ASCII across the 7 affected scripts.
- `parseArgs` now accepts `--flag value` (space form) for `--runtime`/`--repo`/`--antigravity-scope` — the documented forms were previously silently dropped via `npx`. `--antigravity-scope` is now actually forwarded by `install-playwright`.
- `jdi-doctor` section order (Specialists is 11, Caveman is 12); residual `Write-Host` in `jdi-update.ps1` / `jdi-install-caveman.ps1` converted to `Write-Output`.
- `/jdi-add-phase` captures the validator's exit code before the emptiness test (named codes 1–4 now propagate); digit-leading derived slugs are prefixed instead of failing shape validation.

### Docs
- All shipped docs are English (`COMMANDS.md`, `ARCHITECTURE.md`, `MEMORY.md`, and others translated from pt-BR per the project convention). Counts corrected to 6 core agents (`jdi-adopter` was undocumented) / 15 commands / 13 skills / 5 templates; native multi-stack routing documented (previously described as a future feature); `dod-schema.md` listed as the 5th template.

### Breaking changes
- Slash commands reference the CLI plumbing subcommands instead of `bin/lib` paths — re-install runtimes (`npx jdi-cli update`) so installed commands pick up the new invocation.
- New ROADMAPs carry no `Status:` lines and ship no longer edits ROADMAP; anything parsing `- **Status:**` must derive status from phase artifacts (legacy files are still honored on read).
- `enable-update-check` / `disable-update-check` remain removed (0.1.16).
- `jdi install` no longer creates `.githooks/` by default — pass `--githooks`.

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
- Update-notifier pattern adapted from the hook architecture of an external agentic framework studied during development. Cache location and JSON envelope shape are JDI-namespaced.

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
