---
name: jdi-discuss
description: Adaptive question loop to capture locked decisions before planning the phase.
argument_hint: "<phase_number> [--auto]"
runtime_intent:
  invokes_agent: jdi-asker
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, grep, glob]
  opencode:
    agent: jdi-asker
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-discuss"
      - "discuss phase {N}"
      - "start phase discussion"
---

<objective>
Capture locked decisions for the given phase. Output: CONTEXT.md consumed by the planner.
</objective>

<arguments>
- `phase_number` (required): phase number, e.g. `1`, `2`, `3.1`
- `--auto` (optional): asker decides everything, no questions. Use when phase is trivial.
</arguments>

<process>

### Step 1: Validation
1. Confirm `.jdi/` exists. If not: "Run /jdi-new first."
2. Confirm phase exists in ROADMAP.md. If not: "Phase {N} not found."
3. Confirm CONTEXT.md does not yet exist for phase. If yes: ask "overwrite or skip?"

### Step 2: Spawn asker
Invoke `jdi-asker` with:
- `phase_number={N}`
- `mode=auto` if `--auto`, otherwise `mode=interactive`

Agent runs its own process. Returns when CONTEXT.md is written.

### Step 3: Commit
After asker finishes:
```bash
git add .jdi/phases/{NN-slug}/CONTEXT.md .jdi/DECISIONS.md .jdi/todos.md
git commit -m "docs({NN-slug}): capture phase context"
```

### Step 4: Update state
Edit `.jdi/STATE.md`:
- `current_phase: {NN-slug}`
- `next_step: /jdi-plan {N}`

```bash
git add .jdi/STATE.md
git commit -m "chore(state): phase {NN} discussed"
```

### Step 5: Confirm
```
CONTEXT.md ok ({lines} lines, {count} decisions, {creep} in todos.md).
Next: /jdi-plan {N}
```

</process>

<gates>
- pre: `.jdi/` exists + phase listed in ROADMAP.md
- post: CONTEXT.md written + commit made + STATE.md updated
</gates>

<errors>
- ROADMAP.md not found -> exit, suggest /jdi-new
- CONTEXT.md already exists -> ask: overwrite | skip | view
- jdi-asker fails -> no commit, no state update, show error
</errors>
