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

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y jdi-cli render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).
```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new first."; exit 1; }

# Gate promised by the loop: specialists exist before phase work starts
ls .jdi/agents/jdi-doer-*.md >/dev/null 2>&1 || { echo "Doer specialist missing. Run /jdi-bootstrap first."; exit 1; }
ls .jdi/agents/jdi-reviewer-*.md >/dev/null 2>&1 || { echo "Reviewer specialist missing. Run /jdi-bootstrap first."; exit 1; }
```

### Step 2: Resolve phase

```bash
RESOLVED="$(npx -y jdi-cli resolve-phase "$1")" || {
  echo "Phase '$1' not found in ROADMAP."
  exit 1
}
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

### Step 3: Check existing CONTEXT.md

If `$PHASE_DIR/CONTEXT.md` exists, ask: overwrite | skip | view.

### Step 4: Spawn asker
Invoke `jdi-asker` with:
- `phase_slug=$PHASE_SLUG`
- `phase_dir=$PHASE_DIR`
- `phase_position=$PHASE_POSITION` (display only)
- `mode=auto` if `--auto`, otherwise `mode=interactive`
- Orchestrators (e.g. `/jdi-issue`) may additionally pass `brief=<card text>`
  (external card = primary source) and `dod=auto_only` (only executable DoD;
  human-only criteria go to `## Deferred to PR review`) — see the asker's
  `<brief_mode>`

Agent runs its own process. Returns when CONTEXT.md is written to `$PHASE_DIR/CONTEXT.md`.

### Step 4.5: Verify output

```bash
test -f "$PHASE_DIR/CONTEXT.md" || { echo "CONTEXT.md not created"; exit 1; }
grep -q '## Definition of Done' "$PHASE_DIR/CONTEXT.md" || { echo "CONTEXT.md missing § Definition of Done (asker Stage 2 incomplete)"; exit 1; }
```

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
# STATE.md is untracked on 0.3.0+ projects — commit only if a legacy project still tracks it
git add .jdi/STATE.md 2>/dev/null || true
git diff --cached --quiet || git commit -m "chore(state): phase $PHASE_SLUG discussed"
```

### Step 7: Confirm
```
CONTEXT.md ok ({lines} lines, {count} decisions, {creep} in todos.md).
Next: /jdi-plan $PHASE_SLUG
```

</process>

<gates>
- pre: `.jdi/` exists + doer/reviewer specialists exist + phase resolves via `npx -y jdi-cli resolve-phase`
- post: CONTEXT.md written (including `## Definition of Done`) + commit made + STATE.md updated
</gates>

<errors>
- ROADMAP.md not found → exit, suggest /jdi-new
- Phase id not resolvable → exit with hint
- CONTEXT.md already exists → ask: overwrite | skip | view
- jdi-asker fails → no commit, no state update, show error
</errors>
