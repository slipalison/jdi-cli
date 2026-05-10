---
name: jdi-create
description: Creates new JDI agent or skill via validated question loop and automatic integration.
argument_hint: "[optional short description]"
runtime_intent:
  invokes_agent: jdi-architect
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, edit, terminal]
  antigravity:
    triggers:
      - "/jdi-create"
      - "create new agent"
      - "create new skill"
      - "extend jdi"
---

<objective>
Create new agent or skill for JDI through guided flow: question loop -> automatic classification -> validation with user -> generation + integration + smoke test.
</objective>

<arguments>
- `description` (optional): free text describing what to create. Speeds up Q1.

Examples:
- `/jdi-create`
- `/jdi-create "specialist for Rust with cargo + clippy"`
- `/jdi-create "reviewer focused on a11y for UI"`
- `/jdi-create "skill with EF Core 9 conventions"`
</arguments>

<process>

### Step 1: Validation

```bash
test -d .jdi/ || { echo "Not a JDI project. Run /jdi-new."; exit 1; }
test -d core/  || { echo "Source of truth not found. Are you in the JDI repo?"; exit 1; }
```

### Step 2: Spawn architect

Invoke `jdi-architect`:
- If free argument provided, pass as context for Q1
- Otherwise, asker starts from scratch

Wait. Architect runs 12 steps (see `core/agents/jdi-architect.md`).

### Step 3: Verify result

Architect returns 1 of 3 statuses:

- **created** — agent/skill created, integrated, build+install done. Command confirms with user and ends.
- **cancelled** — user cancelled. Command exits clean, no commit.
- **failed** — something went wrong (template missing, name conflict, build failed). Show error, suggest retry.

### Step 4: Confirm

If **created**:
```
jdi-{name} ({type}) ok. Audit: R-{N}. Commit: {sha}.
Invoke: {runtime instructions}
```

</process>

<gates>
- pre: `.jdi/` exists + `core/` exists + clean working tree (no uncommitted changes in `core/` to avoid conflicts)
- post: agent/skill created + integration points updated + build+install done + atomic commit
</gates>

<errors>
- Not a JDI project -> suggest `/jdi-new`
- Source `core/` missing -> not the JDI repo, redirect
- Working tree dirty in `core/` -> ask to commit or stash first
- User cancelled -> exit with no side effects
- Build failed -> do not install, show build error, keep core/ updated for manual retry
</errors>
