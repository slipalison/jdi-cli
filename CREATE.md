# JDI — Create Mechanism

How to create new **agents** and **skills** for the JDI core without bloating the system.

Command: `/jdi-create`. Agent: `jdi-architect` in `create` mode.

Parallel flow of the same architect: `/jdi-bootstrap` invokes `jdi-architect` in `specialist` mode to create per-project doer/reviewer. See [EXTENSION.md](EXTENSION.md).

## When to use `/jdi-create`

Use when:
- You are a contributor to the JDI source (not a consuming user)
- You want to add a generic agent that ALL JDI projects will use
- You want to add a reusable skill loaded by multiple agents

Do NOT use when:
- You want a specialist for YOUR specific project — use `/jdi-bootstrap`
- You want local config — edit `.jdi/` directly
- You are inside a project consuming JDI (no `core/` in the directory)

## Prerequisites

`/jdi-create` is **guarded**: it refuses to run outside the jdi-cli source repo. A consumer project that happens to have its own `core/` folder does not fool it — the check is on the package name:

```bash
grep -q '"name": "jdi-cli"' package.json 2>/dev/null || {
  echo "/jdi-create runs only inside the jdi-cli source repo (it writes to core/)."
  exit 1
}
test -f core/agents/jdi-architect.md || { echo "core/ incomplete — run from the jdi-cli repo root."; exit 1; }
git status --porcelain | wc -l      # clean working tree (recommended)
```

## Step-by-step flow

### 1. Invoke

```
/jdi-create "specialist for Rust with cargo + clippy"
/jdi-create "skill with EF Core 9 conventions"
/jdi-create
```

The free-form argument (optional) speeds up Q1.

### 2. Architect loads context

```bash
ls core/agents/            # existing agents
ls core/skills/            # existing skills
cat .jdi/specialists.md    # routing
cat .jdi/reviewers.md
cat .jdi/skills-registry.md
cat .jdi/registry.md       # creation history
```

Accumulates in memory to avoid duplication.

### 3. 8-question loop

AskUserQuestion one at a time:

| # | Question | Type |
|---|---|---|
| Q1 | What problem does it solve? | free text |
| Q2 | When should it run? | multiple choice |
| Q3 | What does it need to run? (input) | multiple choice |
| Q4 | What does it produce? (output) | multiple choice |
| Q5 | How many callers will use it? | 1 caller / several / don't know |
| Q6 | Does it have a decision loop with retry/branches? | yes / no |
| Q7 | Execution cost? | cheap / medium / deep / N/A |
| Q8 | Required tools? | multiple (Read/Write/Edit/Bash/Web/AskUser/Agent) |

### 4. Automatic classification

```
Q5 = several callers + Q6 = no loop         -> pure SKILL
Q5 = 1 caller + Q6 = loop + file output     -> pure AGENT
Q5 = several + Q6 = loop                    -> COMPOSITE (agent + skill)
Q5 = don't know + tiebreaker via Q6
```

### 5. Anti-pattern check

- Generic name ("review-code") -> asks for focus
- Specialist per feature ("auth") -> redirects to a phase
- Skill > 500 estimated lines -> suggests an agent
- Agent without a decision loop -> suggests a skill
- Soft cap (>15 agents / >25 skills) -> warns
- Name collides -> forces a rename

### 6. Draft plan (preview)

Shows YAML to the user:

```yaml
proposed:
  type: agent
  name: jdi-rust-specialist
  description: Rust specialist with cargo + clippy + rustfmt
  triggers: [execute rust phase, rust files]
  tools: [Read, Write, Edit, Bash]
  model_intent: medium

inputs: [phase_id, .jdi/phases/<slug>/PLAN.md, src/**/*.rs]
outputs: [.jdi/phases/<slug>/SUMMARY.md, Rust code + tests]

files_to_create:
  - core/agents/jdi-rust-specialist.md

integration_points:
  - update .jdi/specialists.md (Rust -> jdi-rust-specialist)

validation_checks:
  - unique name
  - frontmatter matches template
  - triggers do not collide
```

### 7. Validation with the user

AskUserQuestion:
- **Approve** — confirms, proceeds to generation
- **Edit** — which field to change?
- **Cancel** — exits without creating anything

### 8. File generation

#### Agent

Reads `core/templates/agent.md`. Substitutes placeholders:
- `{NAME}`, `{ONE_LINE_DESCRIPTION}`, `{ROLE}`, `{TOOLS_LIST}`, `{TRIGGERS_LIST}`
- `{CLAUDE_MODEL}`, `{CLAUDE_TOOLS}`, `{COPILOT_MODEL}`, etc.

Write to `core/agents/jdi-{name}.md`.

#### Skill

Reads `core/templates/skill.md`. Substitutes placeholders.
mkdir + Write to `core/skills/{name}/SKILL.md`.

If it has references, creates placeholders in `core/skills/{name}/references/`.

#### Composite

Creates both. The agent references the skill in `<skills_to_load>`.

### 9. Update integration points

| Type | Update |
|---|---|
| Specialist (language) | append `.jdi/specialists.md` + edit doer routing |
| Reviewer | append `.jdi/reviewers.md` + edit `/jdi-verify` discovery |
| Skill | append `.jdi/skills-registry.md` + `.jdi/registry.md` + edit `<skills_to_load>` of the loading agents |

### 10. Audit trail

Append to `.jdi/registry.md`:

```markdown
## R-{N} ({date})
**Type:** agent | skill | composite
**Name:** jdi-{name}
**Created by:** /jdi-create
**Why:** {Q1 answer}
**Files:** {list}
**Integration:** {list}
```

### 11. Build + install

```bash
./bin/jdi-build.sh         # or .ps1 on Windows
./bin/jdi-install.sh {runtime} --scope {user|project}
```

Detects the active runtime automatically:
- `~/.claude/` exists? -> claude
- `.github/agents/` exists? -> copilot
- `~/.gemini/antigravity/` -> antigravity
- `~/.config/opencode/` -> opencode
- none -> asks

### 12. Smoke test

Shows the user **how to invoke** what was created:

```
Created: jdi-rust-specialist (agent)

How to invoke:
- Claude Code: spawn via Agent tool with subagent_type=jdi-rust-specialist
- Copilot:     @jdi-rust-specialist in chat
- Antigravity: discovered by trigger, or ask explicitly
- OpenCode:    @jdi-rust-specialist in the TUI

Audit: .jdi/registry.md (R-N)
Commit: {sha}
```

### 13. Commit

```bash
git add core/ .jdi/specialists.md .jdi/reviewers.md .jdi/skills-registry.md .jdi/registry.md runtimes/
git commit -m "feat(jdi-create): add agent jdi-rust-specialist"
```

## Templates

```
core/templates/
  agent.md               <- base for a generic agent
  skill.md               <- base for a skill
  doer-specialist.md     <- used by specialist mode (NOT create mode)
  reviewer-specialist.md <- idem
  dod-schema.md          <- canonical Definition-of-Done spec (referenced by researcher/asker/reviewer)
```

Create mode uses `agent.md` or `skill.md`. Specialist mode uses `doer-specialist.md` + `reviewer-specialist.md`. `dod-schema.md` is a reference spec, not a generation base.

## Generated agent structure

```yaml
---
name: jdi-{name}
description: {1 line}
runtime_intent:
  role: {role}
  reasoning: {cheap|medium|deep}
  privileges: {read|read+write|read+write+edit|read+write+edit+bash}
tools_canonical: [...]
triggers: [...]
runtime_overrides:
  claude:
    model: {opus|sonnet|haiku}
    tools: [...]
  copilot:
    model: gpt-5
    tools: [...]
  opencode:
    mode: subagent
    model: anthropic/claude-sonnet-4-20250514
    permission: { edit, bash, write }
  antigravity:
    triggers_extra: [...]
---

<role>
You are `jdi-{name}`. ...
</role>

<inputs>
- ...
</inputs>

<process>
### Step 1: ...
### Step 2: ...
</process>

<rules>
- ...
</rules>

<fallbacks>
- ...
</fallbacks>

<output>
- ...
</output>
```

## Generated skill structure

```yaml
---
name: {name}
description: {1 line}
type: skill
applies_to: ...
loaded_by: [...]
runtime_overrides:
  antigravity:
    triggers: [...]
---

# Skill: {name}

## When to apply
...

## Procedure
### Step 1: ...

## Expected inputs
...

## Outputs
...

## References
- references/{X}.md
```

## Reverse: deleting

JDI has no `/jdi-delete` command. Manually:

1. `git rm core/agents/jdi-{name}.md` (or `core/skills/{name}/`)
2. Edit `.jdi/specialists.md` or `.jdi/reviewers.md` (remove the row)
3. Append to `.jdi/registry.md`: `R-{N}: removed jdi-{name} ({reason})`
4. `./bin/jdi-build.sh && ./bin/jdi-install.sh {runtime}`
5. `git commit -m "chore(jdi): remove agent jdi-{name}"`

Soft delete preferred: mark `deprecated: true` in the frontmatter, keep the file. Remove physically only when 100% sure.

## See also

- [CREATE-EXAMPLE.md](CREATE-EXAMPLE.md) — concrete walkthrough
- [EXTENSION.md](EXTENSION.md) — when to use create vs bootstrap
- [AGENTS.md](AGENTS.md) — existing agents
- [ARCHITECTURE.md](ARCHITECTURE.md) — overview
