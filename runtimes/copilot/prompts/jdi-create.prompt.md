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

Contributor-only guard — this command writes agents/skills into `core/` of
the jdi-cli SOURCE repo. A consumer project that happens to have its own
`core/` folder must never pass this gate:

```bash
grep -q '"name": "jdi-cli"' package.json 2>/dev/null || {
  echo "/jdi-create runs only inside the jdi-cli source repo (it writes to core/)."
  echo "Consumer projects extend JDI via per-project specialists — see EXTENSION.md."
  exit 1
}
test -f core/agents/jdi-architect.md || { echo "core/ incomplete — run from the jdi-cli repo root."; exit 1; }

# Clean core/ required (avoid mixing generated files with local edits)
DIRTY_CORE=$(git status --porcelain core/ 2>/dev/null || true)
[ -z "$DIRTY_CORE" ] || { echo "core/ has uncommitted changes. Commit or stash first."; exit 1; }
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
jdi-{name} ({type}) ok. Audit: R-{date}-{name}. Commit: {sha}.
Invoke: {runtime instructions}
```

</process>

<gates>
- pre: running inside the jdi-cli source repo (`package.json name == jdi-cli` + `core/agents/jdi-architect.md` present) + `core/` clean
- post: agent/skill created + integration points updated + build+install done + atomic commit
</gates>

<errors>
- Not the jdi-cli source repo -> abort with pointer to EXTENSION.md (consumer path)
- Working tree dirty in `core/` -> ask to commit or stash first
- User cancelled -> exit with no side effects
- Build failed -> do not install, show build error, keep core/ updated for manual retry
</errors>
