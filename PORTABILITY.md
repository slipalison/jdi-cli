# JDI — Portability

JDI runs on 5 runtimes: **Claude Code**, **GitHub Copilot**, **Google Antigravity**, **OpenCode**, **JetBrains Junie (CLI)**.

Strategy: 1 source of truth (`core/`) + adapters per runtime (`runtimes/<name>/`). 1 script that syncs them.

## Mapping across the 5 runtimes

| JDI concept | Claude Code | GitHub Copilot | Antigravity | OpenCode | Junie (JetBrains) |
|---|---|---|---|---|---|
| Command | `.claude/commands/<n>.md` | `.github/prompts/<n>.prompt.md` (VS Code) + `.github/skills/<n>/SKILL.md` (CLI + coding agent — the CLI does NOT read prompts/) | `.agents/skills/<n>/SKILL.md` | `.opencode/commands/<n>.md` | `.junie/skills/<n>/SKILL.md` (as skills — see note) |
| Agent | `.claude/agents/<n>.md` | `.github/agents/<n>.agent.md` | `.agents/skills/<n>/SKILL.md` | `.opencode/agents/<n>.md` | `.junie/agents/<n>.md` |
| Skill | `.claude/skills/<n>/SKILL.md` | `.github/skills/<n>/SKILL.md` (Agent Skills GA Apr/2026; also reads `.claude/skills/` and `.agents/skills/`; user scope `~/.copilot/skills/`) | `.agents/skills/<n>/` (2.0; user scope: `~/.gemini/config/skills/`) | `.opencode/skills/<n>/SKILL.md` (also reads `.claude/skills/`) | `.junie/skills/<n>/SKILL.md` (user scope: `~/.junie/skills/`) |
| Global instructions | `CLAUDE.md` | `.github/copilot-instructions.md` | `agents.md` | `AGENTS.md` | `.junie/AGENTS.md` (+ `.junie/rules/*.md`) |
| Hook | `settings.json` `hooks` | none | none | `opencode.jsonc` `permission` | `~/.junie/config.json` `hooks` |
| Invocation | `/jdi-discuss` | `/jdi-discuss` or `@jdi-asker` | discovery by trigger | `/jdi-discuss` or `@jdi-asker` | semantic discovery (type "/jdi-discuss auth-flow" in the message) |
| Restricted tools | frontmatter `tools:` | frontmatter `tools:` | no formal restriction | frontmatter `permission:` | frontmatter `tools:`/`disallowedTools:` (enforced) |
| Model selection | `model: opus\|sonnet\|haiku` | inherited from picker | not exposed | inherited (or `llm_config`) | inherited — LLM-agnostic by design |
| Subagent flag | implicit (Agent tool spawn) | referenced via `@<name>` | discovery | `mode: subagent` + `subtask: true` | automatic delegation by description match |

**Junie note:** JDI commands ship as Junie **skills**, not Junie custom commands — Junie custom commands require named template arguments (`$phase`) that are all mandatory and would treat the `$VARS` inside JDI command bodies as parameters. Skills use semantic discovery instead: mention the command and the slug in your message ("run /jdi-plan for auth-flow"). Subagents delegate automatically by description match; there is no manual `@agent` invocation.

Refs:
- [Claude Code agents docs](https://docs.claude.com/en/docs/claude-code/sub-agents)
- [GitHub Copilot custom agents](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-custom-agents)
- [Antigravity skills](https://antigravity.google/docs/skills)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [OpenCode commands](https://opencode.ai/docs/commands/)
- [OpenCode skills](https://opencode.ai/docs/skills/)
- [Junie CLI docs](https://junie.jetbrains.com/docs/junie-cli.html) · [subagents](https://junie.jetbrains.com/docs/junie-cli-subagents.html) · [skills](https://junie.jetbrains.com/docs/agent-skills.html)

## Copilot is THREE surfaces, not one

"GitHub Copilot" hides three execution contracts. JDI targets each one explicitly:

| Surface | Who orchestrates | Human? | Sub-agents? | JDI entry point |
|---|---|---|---|---|
| VS Code chat | human types `/jdi-*` | yes | via `@` (manual) | `.github/prompts/` |
| Copilot CLI | human types commands | yes | no | `.github/skills/` (semantic) |
| **Coding agent** (issue delegated on github.com / Linear / etc.) | ONE persona auto-selected by the engine from `.github/agents/` | **no** | **no** | `.github/agents/jdi-solo.agent.md` |

The delegated surface is the dangerous one: no human watching, semantic persona
selection, a harness that auto-commits (and silently drops untracked files), CI
that stays silent until someone clicks "Approve and run workflows". JDI's answer
has three layers:

1. **A correct attractor** — `jdi-solo`, the 7th core agent: end-to-end solo
   executor (terminal required, artifacts before code, gates executed, explicit
   `git add` per artifact). All other jdi-* agents carry an anti-selection
   disclaimer in their description.
2. **In-session enforcement** — `.githooks/pre-commit` blocks code commits
   without staged phase artifacts; `copilot-setup-steps.yml` activates it
   inside the agent's environment.
3. **Merge-point enforcement** — `jdi-artifacts-gate.yml` fails any `copilot/*`
   PR that touches code without the full artifact chain
   (`npx -y jdi-cli validate-phase <slug> --for-pr`).

### Capability degradation matrix (any runtime)

| Missing capability | Defined degradation |
|---|---|
| Sub-agent spawn | solo protocol: one persona plays every role IN SEQUENCE (jdi-solo) — never skip a role |
| Terminal | HARD STOP: report "gates cannot run", produce no code |
| Human (delegated/headless) | /jdi-issue semantics: `mode=auto`, `dod=auto_only`, AUTO-RESET at loop gates, caps intact |
| Reliable file persistence (harness auto-commit) | explicit `git add` + `git ls-files --error-unmatch` after every artifact write; gates validate the INDEX/tree, never the worktree |
| CI visibility (bot PRs) | pre-commit hook = in-session red; PR body warns about "Approve and run workflows" |

## Key differences

### Hooks
**Limitation:** only Claude Code supports native runtime hooks (pre-commit, post-commit, etc).

**Multi-runtime workaround:**
- Hooks ship in `bin/git-hooks/` and are only copied to the project's `.githooks/` when the user opts in via `jdi install <runtime> --githooks`. Since the delegated-agent work: `pre-commit` is the **phase-artifact gate** (blocks code commits without staged CONTEXT.md/PLAN.md of an active phase — the in-session red for coding agents; humans can bypass with `JDI_GATE_DISABLE=1`); `post-commit` stays no-op.
- The reviewer (`/jdi-verify`) covers quality validation — the hook covers protocol presence, not quality
- Users can customize `.githooks/` for:
  - Quick pre-commit lint
  - Post-commit Slack notification
  - Etc.
- To activate: `git config core.hooksPath .githooks`

JDI documents all 4 paths. Users enable what they have.

OpenCode has per-agent `permission:` in the frontmatter — not a hook, but grants granular edit/bash/write control.

### Restricted tools
**Claude Code:** frontmatter `tools: [Read, Write, Edit, Bash, Grep, Glob]` applies least-privilege.

**Copilot:** same syntax, but limited support for some tools.

**Antigravity:** SKILL.md does not restrict tools. Restriction by convention in the skill's prose.

**OpenCode:** granular per-verb `permission:` frontmatter:
```yaml
permission:
  edit: deny       # does not edit project files
  bash:
    "*": ask       # asks before any shell command
    "git status": allow
    "git diff": allow
  write: allow     # can create new files
  skill: allow     # can load skills
```

### Model
**Claude:** `model: opus` / `sonnet` / `haiku` in the frontmatter.

**Copilot:** `model: gpt-5` / `claude-opus-4-7` / etc — depends on org config.

**Antigravity:** transparent. Uses the model active in the IDE.

**OpenCode:** exact `model: <provider>/<id>`. Examples:
- `anthropic/claude-sonnet-4-20250514`
- `anthropic/claude-opus-4-7`
- `openai/gpt-5`
- `google/gemini-2.5-flash`

JDI core declares intent (`reasoning: medium`) — the adapter translates it into a concrete model per runtime.

### Discovery
**Claude:** command must live in `commands/`. Agent must live in `agents/`. Listed by name.

**Copilot:** prompts in `.github/prompts/` listed via `/`. Agents auto-discovered when referenced via `@`.

**Antigravity:** discovery by **semantic match on the `description` field** (2.0 — the 1.x `triggers:` list is ignored but harmless). Descriptions must be specific; the agent picks the skill automatically on match. Project skills live in `.agents/skills/`, user skills in `~/.gemini/config/skills/` (the 1.x `~/.gemini/antigravity/` dir is no longer read).

**OpenCode:** commands in `.opencode/commands/` listed via `/`. Agents in `.opencode/agents/` invoked via `@<name>` or by a command's `agent:` field. Skills discovered by walking up from cwd to the git worktree, reading `.opencode/skills/`, `.claude/skills/`, `.agents/skills/`.

JDI core formats for the worst case (Antigravity needs strong triggers) — the other runtimes ignore the extra field.

## Shell helpers as CLI subcommands

Command prompts never hardcode script paths. Deterministic helpers are exposed as `jdi-cli` subcommands, so every runtime invokes them the same way:

```bash
npx -y jdi-cli resolve-phase <slug|position> [--json]   # phase id -> slug/dir/position env exports
npx -y jdi-cli validate-slug <slug> [--check-unique]    # shape + reserved words + uniqueness
npx -y jdi-cli truncate <file> <max_chars>              # structure-preserving truncation
npx -y jdi-cli monitor <file...>                        # context budget estimate
```

`bin/jdi.js` dispatches each subcommand to the platform-correct implementation in `bin/lib/` (`.ps1` on Windows, `.sh` elsewhere). This is what makes the command `.md` files runtime- and OS-portable: the same `npx -y jdi-cli ...` line works from Claude Code, Copilot, Antigravity, or OpenCode on any OS with Node.

## Phase ID schema (slug-as-ID)

Schema v2 (default in new projects) uses the **slug** as the canonical phase identifier instead of a number. The model is portable across all 5 runtimes — it depends on no runtime-specific feature:

- **STATE.md** carries `schema_version: 2` + `current_phase_slug: <slug>`. The `current_phase` (int) field is kept as a display mirror.
- **Folder** = `.jdi/phases/<slug>/` (v2) or `.jdi/phases/NN-<slug>/` (v1 legacy, preserved).
- **Resolver** (`npx -y jdi-cli resolve-phase`, backed by `bin/lib/jdi-resolve-phase.{sh,ps1}`) normalizes any input (int OR slug) into a resolved path. Every command MD calls the resolver in Step 2 — a cross-runtime invariant.
- **Validator** (`npx -y jdi-cli validate-slug`) enforces shape + reserved words + uniqueness before `/jdi-add-phase` creates a phase.
- **Triggers (Antigravity):** `/jdi-do auth-flow` and `/jdi-do 2` both fire the same skill — prose triggers accept both forms.
- **Slash commands (Claude/Copilot/OpenCode):** `argument_hint: "<slug|position>"`.

Multi-developer safety: two devs on parallel branches creating distinct phases (different slugs) → disjoint folders, clean merge. Same slug → explicit git conflict (a real signal, not a silent overwrite). Phase completion is a per-folder `SHIPPED.md` marker and status is derived from artifacts, so ROADMAP.md never becomes a merge hotspot.

v1 → v2 migration: `/jdi-migrate-phases` command (non-destructive). Per runtime:

| Runtime | How to invoke | Notes |
|---|---|---|
| Claude Code | `/jdi-migrate-phases` | AskUserQuestion for confirmation |
| Copilot | `/jdi-migrate-phases` | No AskUserQuestion — may require `--yes` if prompting is unsupported |
| Antigravity | Triggers: `/jdi-migrate-phases`, `migrate phases`, `upgrade schema`, `schema v2` | Prose-based |
| OpenCode | `/jdi-migrate-phases` | `subtask: true` in the frontmatter |

## Folder structure

```
jdi/
+-- core/                          source of truth
|   +-- agents/                    7 agents
|   |   +-- jdi-researcher.md     Opus   - upfront discovery (greenfield)
|   |   +-- jdi-adopter.md        Opus   - brownfield adoption (detect + confirm)
|   |   +-- jdi-bootstrap.md      Sonnet - fires architect specialist mode
|   |   +-- jdi-asker.md          Sonnet - question loop (decisions + DoD)
|   |   +-- jdi-planner.md        Opus   - decompose phase
|   |   +-- jdi-architect.md      Opus   - meta (create + specialist modes)
|   |   +-- jdi-solo.md           Opus   - end-to-end solo executor (delegated/headless sessions)
|   +-- commands/                  15 commands
|   |   +-- jdi-new.md
|   |   +-- jdi-adopt.md
|   |   +-- jdi-bootstrap.md
|   |   +-- jdi-discuss.md
|   |   +-- jdi-plan.md
|   |   +-- jdi-do.md
|   |   +-- jdi-verify.md
|   |   +-- jdi-confirm-dod.md    confirm/reject manual DoD items
|   |   +-- jdi-loop.md           ralph loop, automatic dev<->review
|   |   +-- jdi-ship.md
|   |   +-- jdi-status.md         read-only snapshot (no agent)
|   |   +-- jdi-add-phase.md      registers phase (slug-as-ID, multi-dev safe)
|   |   +-- jdi-remove-phase.md   removes a future/pending phase
|   |   +-- jdi-migrate-phases.md v1 -> v2 non-destructive upgrade
|   |   +-- jdi-create.md         (contributors only)
|   +-- skills/                    13 skills (code-design enforcement + principles)
|   |   +-- clean-architecture/  +-- clean-code/  +-- ddd/  +-- dry/
|   |   +-- frontend-rules/      +-- frontend-validator/    +-- hexagonal/
|   |   +-- kiss/  +-- onion/  +-- solid/  +-- the-method/
|   |   +-- vertical-slice/  +-- yagni/
|   +-- templates/                 5 templates
|       +-- agent.md              base for a generic agent
|       +-- skill.md              base for a skill
|       +-- doer-specialist.md    used by architect specialist mode
|       +-- reviewer-specialist.md idem
|       +-- dod-schema.md         canonical Definition-of-Done spec
|
+-- runtimes/                      generated, never edit by hand
|   +-- claude/
|   |   +-- agents/
|   |   +-- commands/
|   |   +-- skills/                .claude/skills/<n>/SKILL.md
|   |   +-- CLAUDE.md
|   |   +-- settings.example.json
|   +-- copilot/
|   |   +-- agents/                .github/agents/<n>.agent.md
|   |   +-- prompts/               .github/prompts/<n>.prompt.md
|   |   +-- copilot-instructions.md
|   +-- antigravity/
|   |   +-- skills/                each agent/command becomes <name>/SKILL.md
|   |   +-- agents.md
|   +-- opencode/
|   |   +-- agents/                .opencode/agents/<n>.md
|   |   +-- commands/              .opencode/commands/<n>.md
|   |   +-- skills/                .opencode/skills/<n>/SKILL.md
|   |   +-- AGENTS.md
|   |   +-- opencode.example.jsonc
|
+-- bin/
|   +-- jdi.js                     all-in-one CLI (build/install/doctor/update/uninstall + helper subcommands)
|   +-- jdi-build.sh / .ps1        builds runtimes/ from core/
|   +-- jdi-install.sh / .ps1      installs into ~/.claude, .github/, ~/.gemini/, .opencode/ (+ --githooks opt-in)
|   +-- jdi-doctor.sh / .ps1       9-section diagnostic
|   +-- jdi-update.sh / .ps1       refreshes runtime files in an installed project
|   +-- jdi-uninstall.sh / .ps1    removes JDI from a project (keeps .jdi/ unless --purge)
|   +-- jdi-install-caveman.sh / .ps1     optional: caveman plugin for Claude Code
|   +-- jdi-install-playwright.sh / .ps1  optional: Playwright + MCP config for UI validation
|   +-- lib/                       helper implementations (resolve-phase, validate-slug, truncate, monitor × .sh/.ps1 + ui.js)
|   +-- git-hooks/                 no-op pre-commit/post-commit shipped for --githooks opt-in
|
+-- README.md
+-- ARCHITECTURE.md
+-- AGENTS.md
+-- COMMANDS.md
+-- MEMORY.md             (state schema of the .jdi/ files)
+-- EXTENSION.md
+-- CREATE.md
+-- CREATE-EXAMPLE.md
+-- PORTABILITY.md
+-- CHANGELOG.md
```

## Source-of-truth format (`core/agents/<n>.md`)

```yaml
---
name: jdi-asker
description: Adaptive question loop. Becomes CONTEXT.md.
runtime_intent:
  role: discover_decisions
  reasoning: medium      # cheap | medium | deep
  privileges: read+write
tools_canonical:
  - read
  - write
  - grep
  - glob
  - ask_user_question
triggers:                # used by Antigravity discovery
  - "discuss phase"
  - "context for phase"
  - "decisions for phase"
runtime_overrides:
  claude:
    model: sonnet
    tools: [Read, Write, Grep, Glob, AskUserQuestion]
  copilot:
    model: gpt-5
    tools: [read, write, grep, glob]
  antigravity:
    triggers_extra:
      - "start discuss"
      - "/jdi-discuss"
---

<role>
... agent body in plain markdown ...
</role>

<process>
... flow ...
</process>

<output>
... expected output ...
</output>
```

## Build script (`bin/jdi-build.{sh,ps1}`)

Pseudocode:

```bash
#!/usr/bin/env bash
# Reads core/, generates runtimes/

for agent in core/agents/*.md; do
  name=$(basename "$agent" .md)

  # Claude
  remap_frontmatter "$agent" \
    --map "tools_canonical -> tools" \
    --map "runtime_overrides.claude.model -> model" \
    --strip "runtime_intent,triggers,runtime_overrides" \
    > "runtimes/claude/agents/$name.md"

  # Copilot
  remap_frontmatter "$agent" \
    --map "tools_canonical -> tools" \
    --map "runtime_overrides.copilot.model -> model" \
    --strip "runtime_intent,triggers,runtime_overrides" \
    > "runtimes/copilot/agents/$name.agent.md"

  # Antigravity
  mkdir -p "runtimes/antigravity/skills/$name"
  to_skill_format "$agent" \
    --strip "runtime_overrides,tools_canonical" \
    --merge-triggers "runtime_overrides.antigravity.triggers_extra" \
    > "runtimes/antigravity/skills/$name/SKILL.md"
done

# Commands and skills follow the same pattern (OpenCode included)
```

Real implementation: **pure bash — frontmatter-bounded inline parser, no yq/jq required** (`bin/jdi-build.sh`; only bash, sed, awk, mkdir). `bin/jdi-build.ps1` mirrors it 1:1 for Windows, emitting BOM-less UTF-8 so both shells produce byte-identical `runtimes/`.

## Install script (`bin/jdi-install.{sh,ps1}`)

> **Illustrative, simplified.** The real script covers all 4 runtimes (including OpenCode), copies skills (`runtimes/claude/skills/` → `.claude/skills/`, reused by OpenCode), generates `opencode.jsonc` from the example, and supports the `--githooks` opt-in that copies the no-op hooks from `bin/git-hooks/` to the project's `.githooks/`.

```bash
#!/usr/bin/env bash
# Usage: ./jdi-install.sh <runtime> [--scope user|project] [--githooks]
#
# runtimes: claude | copilot | antigravity | opencode | all
# scope:    user (global) | project (default)

install_claude() {
  DEST="$PWD/.claude"                       # or $HOME/.claude with --scope user
  mkdir -p "$DEST/agents" "$DEST/commands" "$DEST/skills"
  cp -r runtimes/claude/agents/*   "$DEST/agents/"
  cp -r runtimes/claude/commands/* "$DEST/commands/"
  cp -r runtimes/claude/skills/*   "$DEST/skills/"
  cp runtimes/claude/CLAUDE.md "$PWD/CLAUDE.md"
}

install_copilot() {
  DEST="$PWD/.github"
  mkdir -p "$DEST/agents" "$DEST/prompts"
  cp -r runtimes/copilot/agents/*  "$DEST/agents/"
  cp -r runtimes/copilot/prompts/* "$DEST/prompts/"
  cp runtimes/copilot/copilot-instructions.md "$DEST/copilot-instructions.md"
}

install_antigravity() {
  # Antigravity 2.0 (May 2026) canonical paths — the 1.x
  # .gemini/antigravity/ dir is no longer read by the 2.0 suite.
  DEST="$PWD/.agents"                       # or $HOME/.gemini/config with --scope user
  mkdir -p "$DEST/skills"
  cp -r runtimes/antigravity/skills/* "$DEST/skills/"
  cp runtimes/antigravity/agents.md "$DEST/agents.md"   # project scope only
}

install_opencode() {
  DEST="$PWD/.opencode"                     # or $HOME/.config/opencode with --scope user
  mkdir -p "$DEST/agents" "$DEST/commands" "$DEST/skills"
  cp -r runtimes/opencode/agents/*   "$DEST/agents/"
  cp -r runtimes/opencode/commands/* "$DEST/commands/"
  cp -r runtimes/opencode/skills/*   "$DEST/skills/"
  cp runtimes/opencode/AGENTS.md "$PWD/AGENTS.md"
  # + opencode.jsonc generated from opencode.example.jsonc if absent
}
```

## Differences that need attention

### 1. AskUserQuestion
- **Claude:** native tool
- **Copilot:** `vscode_askquestions` (equivalent)
- **Antigravity:** no formal equivalent — the skill instructs the agent to ask in normal chat

JDI core writes an "ASK_USER" abstraction in the prompt. The adapter substitutes it.

### 2. Bash execution
- **Claude:** `Bash` tool with sandbox/permissions
- **Copilot:** limited execute_shell tool
- **Antigravity:** scripts in `scripts/` invokable via path

JDI core uses bash pseudocode. The adapter wraps it in the right format.

### 3. Web access
- **Claude:** WebSearch + WebFetch
- **Copilot:** access via plugin/MCP
- **Antigravity:** direct access, tools vary

JDI core uses "WEB_FETCH(<url>)" and "WEB_SEARCH(<query>)". The adapter maps them.

### 4. MCP / ctx7
**Claude and Copilot support MCP natively.** Antigravity has partial support.

JDI uses `ctx7` as a universal CLI fallback — works everywhere. Agents prefer ctx7 when MCP is unavailable.

## Guaranteed minimum behavior

Every JDI agent **must** work with:
- Read, Write, Edit, Bash (any subset)
- No MCP
- No hooks
- No AskUserQuestion (degrades to a textual prompt)

This guarantees that even on the most restricted runtime (Antigravity without MCP, or Copilot CLI), the agent runs.

Fallbacks documented per agent in `core/agents/<n>.md`:

```markdown
<fallbacks>
- No AskUserQuestion -> print numbered options, wait for text answer
- No ctx7 -> WebSearch official docs as fallback
- No WebSearch -> use training knowledge tagged [ASSUMED]
</fallbacks>
```

## Install sequence

**Linux / macOS / WSL:**

```bash
# Clone JDI
git clone https://github.com/<user>/jdi.git
cd jdi

# Build adapters
./bin/jdi-build.sh

# Install into the runtime(s) you use
./bin/jdi-install.sh claude --scope user
./bin/jdi-install.sh copilot --scope project
./bin/jdi-install.sh antigravity --scope user
./bin/jdi-install.sh opencode --scope user
```

**Windows (native PowerShell):**

```powershell
git clone https://github.com/<user>/jdi.git
cd jdi

# Build adapters
.\bin\jdi-build.ps1

# Install into the runtime(s) you use
.\bin\jdi-install.ps1 -Runtime claude -Scope user
.\bin\jdi-install.ps1 -Runtime copilot -Scope project
.\bin\jdi-install.ps1 -Runtime antigravity -Scope user
.\bin\jdi-install.ps1 -Runtime opencode -Scope user
```

Or via the npm package, no clone needed: `npx -y jdi-cli install <runtime> [--scope user|project] [--githooks]`.

For new projects: `jdi install all --scope project` leaves all 4 runtimes ready in the project. Add `--githooks` to also copy the no-op git hooks to `.githooks/` (opt-in).

### `.sh` / `.ps1` equivalence

| Bash (Linux/Mac/WSL) | PowerShell (Windows) |
|---|---|
| `./bin/jdi-build.sh [runtime]` | `.\bin\jdi-build.ps1 [-Target runtime]` |
| `./bin/jdi-install.sh <runtime> --scope <s> [--githooks]` | `.\bin\jdi-install.ps1 -Runtime <runtime> -Scope <s> [-Githooks]` |
| `./bin/jdi-doctor.sh [--verbose]` | `.\bin\jdi-doctor.ps1 [-Verbose]` |

The scripts generate exactly the same files in `runtimes/`. You can run `.sh` on one machine and `.ps1` on another — identical output.

### Cache breakpoints (prompt caching)

JDI ships a prompt-cache convention via `cache_breakpoints:` frontmatter in the `doer-specialist.md` and `reviewer-specialist.md` templates. A list of stable paths (PROJECT.md, DECISIONS.md, specialist body) that qualify as a cache prefix.

**Support per runtime:**

| Runtime | Support | How |
|---|---|---|
| Claude Code | yes — `cache_control` in the API | Harness applies it to system prompt + tool defs automatically when the subagent is spawned |
| OpenCode | yes — passed through to the Anthropic provider | Enabled by default on providers that support it |
| Copilot | n/a | No cache control in GHCP. Frontmatter is ignored |
| Antigravity | n/a | No cache control. Frontmatter is ignored |

The convention is **declarative**: the frontmatter declares what **does not change** between tasks of the same phase. Runtimes that understand it use it — others ignore it without warning. Zero code. Zero deps.

**Why it pays off:** a prefix-match cache hit cuts 70-80% of input-token cost in multi-task flows within the same phase (Claude API: cache write 1.25x, cache read 0.1x).

## Known limitations

| Limitation | Workaround |
|---|---|
| Copilot/Antigravity without runtime hooks | git hooks in `.githooks/` (opt-in via `--githooks`) |
| Antigravity without tool restriction | convention via prose in SKILL.md |
| Copilot prompt files invoked manually, not auto | user has to type `/jdi-discuss` — no auto-advance |
| Copilot coding agent (delegated issues): single semantic-selected persona, no sub-agents, harness may drop untracked files | `jdi-solo` persona + anti-selection disclaimers + pre-commit artifact gate + `jdi-artifacts-gate.yml` CI check (see "Copilot is THREE surfaces") |
| OpenCode verbose model id | `runtime_overrides.opencode.model` declares it explicitly |
| OpenCode per-verb permission (edit/bash/write) | maps 1:1 — no granularity loss |
| Antigravity trigger discovery -> false positives | specific triggers with the `jdi-` prefix |
| Different models per runtime | `runtime_overrides` frontmatter declares intent |
| Tools with different names (Read vs read_file) | adapter normalizes per runtime |

## Sources

- [GitHub Copilot custom agents docs](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-custom-agents)
- [Custom agents in VS Code](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [Antigravity skills](https://antigravity.google/docs/skills)
- [Authoring Antigravity skills (codelab)](https://codelabs.developers.google.com/getting-started-with-antigravity-skills)
- [Awesome Copilot (community)](https://github.com/github/awesome-copilot)
- [Antigravity awesome skills (community)](https://github.com/sickn33/antigravity-awesome-skills)
