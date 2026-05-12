---
name: jdi-discuss
description: Adaptive question loop to capture locked decisions before planning the phase. Accepts slug or position.
argument_hint: "<slug|position> [--auto]"
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
      - "discuss phase"
      - "start phase discussion"
---

<objective>
Capture locked decisions for the given phase. Output: CONTEXT.md consumed by the planner.
</objective>

<arguments>
- `phase_id` (required): canonical slug (`auth-flow`), legacy slug (`02-auth-flow`), or integer position (`2`)
- `--auto` (optional): asker decides everything, no questions. Use when phase is trivial.
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new first."; exit 1; }

JDI_LIB="$(dirname "$(command -v jdi 2>/dev/null || echo /usr/local/bin/jdi)")/../lib"
```

### Step 2: Resolve phase

```bash
eval $(bash "$JDI_LIB/jdi-resolve-phase.sh" "$1") || {
  echo "Phase '$1' not found in ROADMAP."
  exit 1
}

PHASE_SLUG="$JDI_PHASE_SLUG"
PHASE_DIR="$JDI_PHASE_DIR"
PHASE_POSITION="$JDI_PHASE_POSITION"
```

PowerShell:
```powershell
$r = & "$JDI_LIB\jdi-resolve-phase.ps1" -Id $args[0] -AsObject
$phaseSlug = $r.Slug; $phaseDir = $r.Dir; $phasePosition = $r.Position
```

### Step 3: Check existing CONTEXT.md

If `$PHASE_DIR/CONTEXT.md` exists, ask: overwrite | skip | view.

### Step 4: Spawn asker
Invoke `jdi-asker` with:
- `phase_slug=$PHASE_SLUG`
- `phase_dir=$PHASE_DIR`
- `phase_position=$PHASE_POSITION` (display only)
- `mode=auto` if `--auto`, otherwise `mode=interactive`

Agent runs its own process. Returns when CONTEXT.md is written to `$PHASE_DIR/CONTEXT.md`.

### Step 5: Commit
```bash
git add "$PHASE_DIR/CONTEXT.md" .jdi/DECISIONS.md .jdi/todos.md 2>/dev/null
git commit -m "docs($PHASE_SLUG): capture phase context"
```

### Step 6: Update state
Edit `.jdi/STATE.md`:
- `current_phase: $PHASE_POSITION` (legacy mirror, kept for v1 reading)
- `current_phase_slug: $PHASE_SLUG`
- `next_step: /jdi-plan $PHASE_SLUG`

```bash
git add .jdi/STATE.md
git commit -m "chore(state): phase $PHASE_SLUG discussed"
```

### Step 7: Confirm
```
CONTEXT.md ok ({lines} lines, {count} decisions, {creep} in todos.md).
Next: /jdi-plan $PHASE_SLUG
```

</process>

<gates>
- pre: `.jdi/` exists + phase resolves via `jdi-resolve-phase.sh`
- post: CONTEXT.md written + commit made + STATE.md updated
</gates>

<errors>
- ROADMAP.md not found → exit, suggest /jdi-new
- Phase id not resolvable → exit with hint
- CONTEXT.md already exists → ask: overwrite | skip | view
- jdi-asker fails → no commit, no state update, show error
</errors>
