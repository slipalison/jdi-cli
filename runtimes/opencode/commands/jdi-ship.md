---
name: jdi-ship
description: Finalizes phase after verify. Updates ROADMAP.md, marks phase as done, advances pointer to next.
argument_hint: "<phase_number>"
runtime_intent:
  invokes_agent: none
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion]
  copilot:
    tools: [read, write, edit, grep, glob, terminal]
  opencode:
    subtask: true
  antigravity:
    triggers:
      - "/jdi-ship"
      - "finalize phase {N}"
---

<objective>
Finalizes phase after /jdi-verify approves. Updates ROADMAP.md (phase: done), advances STATE to next phase, final commit.
</objective>

<arguments>
- `phase_number` (required)
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ || { echo "Not a JDI project."; exit 1; }

# Verify REVIEW.md exists
ls .jdi/phases/{NN}*/REVIEW.md 2>/dev/null || {
  echo "REVIEW.md missing. /jdi-verify {N}."
  exit 1
}

# Read verdict
VERDICT=$(grep -oE 'Verdict:\*\* (APPROVED|APPROVED_WITH_WARNINGS|BLOCKED)' .jdi/phases/{NN}*/REVIEW.md | awk '{print $2}')

if [ "$VERDICT" = "BLOCKED" ]; then
  echo "Phase {N} BLOCKED. Fix before ship."
  exit 1
fi
```

### Step 2: Confirm with user (only if WITH_WARNINGS)

If `VERDICT=APPROVED_WITH_WARNINGS`:
```
Phase {N} has uncorrected warnings. Ship anyway?
- Yes, ship (warnings remain in REVIEW.md)
- No, fix first
```

If "No" -> exit clean.

### Step 3: Update ROADMAP.md

Edit `.jdi/ROADMAP.md`:
- Phase {N}: `status: done`
- Phase {N+1}: `status: ready` (if exists)

If no phase {N+1}:
```
All phases complete.
Project delivered.
```

### Step 4: Update STATE.md

```markdown
current_phase: {N+1 or done}
phase_status: ready (if {N+1} exists) or complete
next_step: /jdi-discuss {N+1} or done
```

### Step 5: Archive old phases (compaction)

Read `archive_after` from `.jdi/config.json` (default 5). If current phase advances to `N+1`, and a phase exists with number `<= (N+1) - archive_after`, move to `.jdi/archive/`.

```bash
ARCHIVE_AFTER=5
if [ -f .jdi/config.json ]; then
  if command -v jq >/dev/null 2>&1; then
    ARCHIVE_AFTER=$(jq -r '.compaction.archive_after // 5' .jdi/config.json)
  fi
fi

NEXT=$((N + 1))
THRESHOLD=$((NEXT - ARCHIVE_AFTER))

if [ "$THRESHOLD" -ge 1 ]; then
  mkdir -p .jdi/archive
  test -f .jdi/archive/index.md || echo "# Archive index" > .jdi/archive/index.md

  for dir in .jdi/phases/*/; do
    NN=$(basename "$dir" | grep -oE '^[0-9]+' || true)
    [ -z "$NN" ] && continue
    NN_NUM=$((10#$NN))  # force decimal
    if [ "$NN_NUM" -le "$THRESHOLD" ]; then
      VERDICT_OLD=$(grep -oE 'Verdict:\*\* (APPROVED|APPROVED_WITH_WARNINGS|BLOCKED)' "$dir/REVIEW.md" 2>/dev/null | awk '{print $2}' || echo "UNKNOWN")
      mv "$dir" .jdi/archive/
      echo "- $(basename "$dir"): ${VERDICT_OLD} (archived $(date -u +%F))" >> .jdi/archive/index.md
    fi
  done
fi
# Windows: equivalent in PowerShell — Move-Item + Add-Content
```

Archived phases remain accessible via `.jdi/archive/` but exit the default read-path. Read-depth rule (`ARCHITECTURE.md > Read-depth scaling`) treats archive as `<= current - 2`.

### Step 6: Final commit

```bash
git add .jdi/ROADMAP.md .jdi/STATE.md .jdi/archive/ 2>/dev/null
git commit -m "feat({NN-slug}): ship phase {N} ({VERDICT})"
```

Optional tag (if PROJECT.md has `tag_phases: true`):
```bash
git tag "phase-{N}-{slug}"
```

### Step 7: Confirm

```
Phase {N} shipped.
{if more phases:} Next: /jdi-discuss {N+1}
{if last:} Project delivered. Tag: phase-{N}-{slug}
```

</process>

<gates>
- pre: REVIEW.md exists + verdict != BLOCKED
- post: ROADMAP.md + STATE.md updated + old phases archived (if applicable) + commit (+ optional tag)
</gates>

<errors>
- REVIEW missing -> /jdi-verify
- Verdict BLOCKED -> abort
- Already shipped -> abort with warning
</errors>
