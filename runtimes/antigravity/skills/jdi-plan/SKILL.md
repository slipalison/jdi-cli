---
name: jdi-plan
description: Generates phase PLAN.md. Decomposes into tasks with files_modified, acceptance, parallelism waves.
argument_hint: "<phase_number> [--review]"
runtime_intent:
  invokes_agent: jdi-planner
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, grep, glob]
  opencode:
    agent: jdi-planner
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-plan"
      - "plan phase {N}"
---

<objective>
Generates PLAN.md for the given phase. Decomposes into tasks (max 8), groups into parallelism waves, maps files_modified and acceptance.
</objective>

<arguments>
- `phase_number` (required): phase number, e.g. `1`, `2`
- `--review` (optional): show preview and ask for approval before saving
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ || { echo "Not a JDI project. Run /jdi-new."; exit 1; }
test -f .jdi/PROJECT.md || { echo "PROJECT.md missing."; exit 1; }
```

Verify phase CONTEXT.md exists:
```bash
ls .jdi/phases/{NN}*/CONTEXT.md 2>/dev/null || { echo "CONTEXT.md missing. Run /jdi-discuss {N}"; exit 1; }

# Context budget warm-up (does not block)
JDI_LIB="$(dirname "$(command -v jdi 2>/dev/null || echo /usr/local/bin/jdi)")/../lib"
if [ -f "$JDI_LIB/jdi-monitor.sh" ]; then
  bash "$JDI_LIB/jdi-monitor.sh" .jdi/PROJECT.md .jdi/DECISIONS.md .jdi/phases/{NN}*/CONTEXT.md || true
fi
# Windows: pwsh -File "$JDI_LIB/jdi-monitor.ps1" -Paths @(...)
```

### Step 2: Spawn planner
Invoke `jdi-planner` with phase_number. Wait.

### Step 3: Verify
```bash
test -f .jdi/phases/{NN}*/PLAN.md || { echo "PLAN.md not created"; exit 1; }
```

### Step 4: Confirm
Show plan summary + suggest `/jdi-do {N}`.

</process>

<gates>
- pre: `.jdi/PROJECT.md` + `.jdi/phases/{NN-slug}/CONTEXT.md` exist
- post: PLAN.md created + STATE.md updated + commit
</gates>

<errors>
- CONTEXT.md missing -> suggest `/jdi-discuss {N}`
- Phase does not exist in ROADMAP -> error
- Planner cancelled -> exit clean
</errors>
