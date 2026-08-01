---
name: jdi-plan
description: Generates phase PLAN.md. Decomposes into tasks with files_modified, acceptance, parallelism waves. Accepts slug or position.
argument_hint: "<slug|position> [--review]"
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
  antigravity:
    triggers:
      - "/jdi-plan"
      - "plan phase"
---

<objective>
Generates PLAN.md for the given phase. Decomposes into tasks (max 8), groups into parallelism waves, maps files_modified and acceptance.
</objective>

<arguments>
- `phase_id` (required): canonical slug, legacy slug, or integer position
- `--review` (optional): show preview and ask for approval before saving
</arguments>

<process>

### Step 1: Validation

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y jdi-cli render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).
```bash
test -d .jdi/ || { echo "Not a JDI project. Run /jdi-new."; exit 1; }
test -f .jdi/PROJECT.md || { echo "PROJECT.md missing."; exit 1; }
```

### Step 2: Resolve phase

```bash
RESOLVED="$(npx -y jdi-cli resolve-phase "$1")" || { echo "Phase '$1' not found."; exit 1; }
eval "$RESOLVED"
PHASE_SLUG="$JDI_PHASE_SLUG"
PHASE_DIR="$JDI_PHASE_DIR"
PHASE_POSITION="$JDI_PHASE_POSITION"
```

PowerShell:
```powershell
$r = npx -y jdi-cli resolve-phase $args[0] --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { Write-Error "Phase '$($args[0])' not found."; exit $LASTEXITCODE }
$phaseSlug = $r.slug; $phaseDir = $r.dir; $phasePosition = $r.position
```

### Step 3: Verify CONTEXT.md

```bash
test -f "$PHASE_DIR/CONTEXT.md" || { echo "CONTEXT.md missing. Run /jdi-discuss $PHASE_SLUG"; exit 1; }

# Context budget warm-up (does not block)
npx -y jdi-cli monitor .jdi/PROJECT.md .jdi/DECISIONS.md "$PHASE_DIR/CONTEXT.md" || true
```

PowerShell: `npx -y jdi-cli monitor .jdi/PROJECT.md .jdi/DECISIONS.md "$phaseDir/CONTEXT.md"`.

### Step 4: Spawn planner
Invoke `jdi-planner` with:
- `phase_slug=$PHASE_SLUG`
- `phase_dir=$PHASE_DIR`
- `phase_position=$PHASE_POSITION`

Wait.

### Step 5: Verify
```bash
test -f "$PHASE_DIR/PLAN.md" || { echo "PLAN.md not created"; exit 1; }
```

### Step 6: Confirm
Show plan summary + suggest `/jdi-do $PHASE_SLUG`.

</process>

<gates>
- pre: `.jdi/PROJECT.md` + `$PHASE_DIR/CONTEXT.md` exist
- post: PLAN.md created + STATE.md updated + commit
</gates>

<errors>
- CONTEXT.md missing → suggest `/jdi-discuss $PHASE_SLUG`
- Phase id not resolvable → exit with hint
- Planner cancelled → exit clean
</errors>
