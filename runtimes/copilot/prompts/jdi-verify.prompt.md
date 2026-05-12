---
name: jdi-verify
description: Runs phase quality gates via reviewer specialist. Build, tests, coverage, lint, security checks. Verdict APPROVED / APPROVED_WITH_WARNINGS / BLOCKED. Accepts slug or position.
argument_hint: "<slug|position>"
runtime_intent:
  invokes_agent: dynamic
runtime_overrides:
  claude:
    allowed-tools: [Read, Bash, Grep, Glob, Agent]
  copilot:
    tools: [read, grep, glob, terminal]
  opencode:
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-verify"
      - "verify phase"
---

<objective>
Verifies the phase was delivered correctly. Runs gates defined in the project's reviewer specialist. Verdict blocks or releases the ship.
</objective>

<arguments>
- `phase_id` (required): canonical slug, legacy slug, or integer position
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ || { echo "Not a JDI project."; exit 1; }

JDI_LIB="$(dirname "$(command -v jdi 2>/dev/null || echo /usr/local/bin/jdi)")/../lib"

# Verify reviewer exists
ls .jdi/agents/jdi-reviewer-*.md 2>/dev/null | head -1 || {
  echo "Reviewer missing. /jdi-bootstrap."
  exit 1
}
```

### Step 2: Resolve phase

```bash
eval $(bash "$JDI_LIB/jdi-resolve-phase.sh" "$1") || { echo "Phase '$1' not found."; exit 1; }
PHASE_SLUG="$JDI_PHASE_SLUG"
PHASE_DIR="$JDI_PHASE_DIR"
PHASE_POSITION="$JDI_PHASE_POSITION"

# Verify phase was executed
test -f "$PHASE_DIR/SUMMARY.md" || {
  echo "Phase $PHASE_SLUG not executed. /jdi-do $PHASE_SLUG."
  exit 1
}

# Context budget warm-up
if [ -f "$JDI_LIB/jdi-monitor.sh" ]; then
  bash "$JDI_LIB/jdi-monitor.sh" .jdi/PROJECT.md .jdi/DECISIONS.md "$PHASE_DIR/PLAN.md" "$PHASE_DIR/SUMMARY.md" || true
fi
```

### Step 3: Resolve reviewer specialist(s)

```bash
REVIEWERS=$(grep -oE 'jdi-reviewer-[a-z0-9-]+' .jdi/reviewers.md | sort -u)
REVIEWER_COUNT=$(echo "$REVIEWERS" | wc -l)
echo "Reviewers registered: $REVIEWER_COUNT"
```

**Single-stack** (`REVIEWER_COUNT == 1`): one reviewer, normal flow.
**Multi-stack** (`REVIEWER_COUNT > 1`): chain reviewers in registry order. Each writes its own REVIEW segment; aggregate verdict = worst-case (1 BLOCK = overall BLOCK).

### Step 4: Spawn reviewer(s)

**Single-stack:**
```
Agent(
  subagent_type="${REVIEWERS}",
  description="Verify phase $PHASE_SLUG",
  prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, mode=verify"
)
```

**Multi-stack:** spawn each reviewer in sequence (NOT parallel — build/test commands may conflict on ports, locks, output dirs):

```
for REVIEWER in $REVIEWERS:
  Agent(
    subagent_type="$REVIEWER",
    description="Verify phase $PHASE_SLUG ($REVIEWER)",
    prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, mode=verify, reviewer_segment=$REVIEWER"
  )
  # Each reviewer appends to $PHASE_DIR/REVIEW.md under section
  # "## Reviewer: $REVIEWER" with its own gate results and verdict
```

Each reviewer scopes its gates to its `file_glob` (from frontmatter `scope.file_glob`). Coverage threshold enforced only on files matching the glob.

Reviewers are read-only. Wait for completion before next.

### Step 5: Read aggregate verdict

```bash
test -f "$PHASE_DIR/REVIEW.md" || { echo "REVIEW.md not created"; exit 1; }

VERDICTS=$(grep -oE 'Verdict:\*\* (APPROVED|APPROVED_WITH_WARNINGS|BLOCKED)' "$PHASE_DIR/REVIEW.md" | awk '{print $2}')

# Worst-case wins: BLOCK > WARNINGS > APPROVED
if echo "$VERDICTS" | grep -q BLOCKED; then
  VERDICT=BLOCKED
elif echo "$VERDICTS" | grep -q APPROVED_WITH_WARNINGS; then
  VERDICT=APPROVED_WITH_WARNINGS
else
  VERDICT=APPROVED
fi
```

### Step 6: Update STATE

```markdown
current_phase: $PHASE_POSITION
current_phase_slug: $PHASE_SLUG
phase_status: {verified|blocked}
phase_verdict: {APPROVED|APPROVED_WITH_WARNINGS|BLOCKED}
next_step: {if APPROVED or WITH_WARNINGS: /jdi-ship $PHASE_SLUG; if BLOCKED: fix and /jdi-do $PHASE_SLUG again}
```

```bash
git add "$PHASE_DIR/REVIEW.md" .jdi/STATE.md
git commit -m "docs($PHASE_SLUG): verify phase ($VERDICT)"
```

### Step 7: Confirm

**APPROVED:**
```
Phase $PHASE_SLUG: APPROVED. Next: /jdi-ship $PHASE_SLUG
```

**APPROVED_WITH_WARNINGS:**
```
Phase $PHASE_SLUG: APPROVED_WITH_WARNINGS ({count} warnings).
REVIEW.md: $PHASE_DIR/REVIEW.md
Next: /jdi-ship $PHASE_SLUG (or fix first)
```

**BLOCKED:**
```
Phase $PHASE_SLUG: BLOCKED ({count} blockers). REVIEW.md: $PHASE_DIR/REVIEW.md
Fix → /jdi-do $PHASE_SLUG → /jdi-verify $PHASE_SLUG
```

</process>

<gates>
- pre: SUMMARY.md exists + reviewer registered in .jdi/reviewers.md
- post: REVIEW.md created + STATE updated
</gates>

<errors>
- Reviewer missing → /jdi-bootstrap
- SUMMARY missing → /jdi-do
- Reviewer fails → show error, keep state, suggest retry
</errors>
