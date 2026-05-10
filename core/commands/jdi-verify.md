---
name: jdi-verify
description: Runs phase quality gates via reviewer specialist. Build, tests, coverage, lint, security checks. Verdict APPROVED / APPROVED_WITH_WARNINGS / BLOCKED.
argument_hint: "<phase_number>"
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
      - "verify phase {N}"
---

<objective>
Verifies the phase was delivered correctly. Runs gates defined in the project's reviewer specialist. Verdict blocks or releases the ship.
</objective>

<arguments>
- `phase_number` (required)
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ || { echo "Not a JDI project."; exit 1; }

# Verify reviewer exists
ls .jdi/agents/jdi-reviewer-*.md 2>/dev/null | head -1 || {
  echo "Reviewer missing. /jdi-bootstrap."
  exit 1
}

# Verify phase was executed
ls .jdi/phases/{NN}*/SUMMARY.md 2>/dev/null || {
  echo "Phase {N} not executed. /jdi-do {N}."
  exit 1
}

# Context budget warm-up (does not block)
JDI_LIB="$(dirname "$(command -v jdi 2>/dev/null || echo /usr/local/bin/jdi)")/../lib"
if [ -f "$JDI_LIB/jdi-monitor.sh" ]; then
  bash "$JDI_LIB/jdi-monitor.sh" .jdi/PROJECT.md .jdi/DECISIONS.md .jdi/phases/{NN}*/PLAN.md .jdi/phases/{NN}*/SUMMARY.md || true
fi
# Windows: pwsh -File "$JDI_LIB/jdi-monitor.ps1" -Paths @(...)
```

### Step 2: Resolve reviewer specialist(s)

```bash
REVIEWERS=$(grep -oE 'jdi-reviewer-[a-z0-9-]+' .jdi/reviewers.md | sort -u)
REVIEWER_COUNT=$(echo "$REVIEWERS" | wc -l)
echo "Reviewers registered: $REVIEWER_COUNT"
```

**Single-stack** (`REVIEWER_COUNT == 1`): one reviewer, normal flow.
**Multi-stack** (`REVIEWER_COUNT > 1`): chain reviewers in registry order. Each writes its own REVIEW segment; aggregate verdict = worst-case (1 BLOCK = overall BLOCK).

### Step 3: Spawn reviewer(s)

**Single-stack:**
```
Agent(
  subagent_type="${REVIEWERS}",
  description="Verify phase {N}",
  prompt="phase={N}, mode=verify"
)
```

**Multi-stack:** spawn each reviewer in sequence (NOT parallel — build/test commands may conflict on ports, locks, output dirs):

```
for REVIEWER in $REVIEWERS:
  Agent(
    subagent_type="$REVIEWER",
    description="Verify phase {N} ({REVIEWER})",
    prompt="phase={N}, mode=verify, reviewer_segment=${REVIEWER}"
  )
  # Each reviewer appends to .jdi/phases/{NN-slug}/REVIEW.md under section
  # "## Reviewer: {REVIEWER}" with its own gate results and verdict
```

Each reviewer scopes its gates to its `file_glob` (from frontmatter `scope.file_glob`). Coverage threshold enforced only on files matching the glob.

Reviewers are read-only. Wait for completion before next.

### Step 4: Read aggregate verdict

```bash
test -f .jdi/phases/{NN}*/REVIEW.md || { echo "REVIEW.md not created"; exit 1; }

# Collect all per-reviewer verdicts
VERDICTS=$(grep -oE 'Verdict:\*\* (APPROVED|APPROVED_WITH_WARNINGS|BLOCKED)' .jdi/phases/{NN}*/REVIEW.md | awk '{print $2}')

# Worst-case wins: BLOCK > WARNINGS > APPROVED
if echo "$VERDICTS" | grep -q BLOCKED; then
  VERDICT=BLOCKED
elif echo "$VERDICTS" | grep -q APPROVED_WITH_WARNINGS; then
  VERDICT=APPROVED_WITH_WARNINGS
else
  VERDICT=APPROVED
fi

# For single-stack, this collapses to the single reviewer's verdict — backward compatible.
```

### Step 5: Update STATE

```markdown
current_phase: {N}
phase_status: {verified|blocked}
phase_verdict: {APPROVED|APPROVED_WITH_WARNINGS|BLOCKED}
next_step: {if APPROVED or WITH_WARNINGS: /jdi-ship {N}; if BLOCKED: fix and /jdi-do {N} again}
```

```bash
git add .jdi/phases/{NN-slug}/REVIEW.md .jdi/STATE.md
git commit -m "docs({NN-slug}): verify phase ({VERDICT})"
```

### Step 6: Confirm

**APPROVED:**
```
Phase {N}: APPROVED. Next: /jdi-ship {N}
```

**APPROVED_WITH_WARNINGS:**
```
Phase {N}: APPROVED_WITH_WARNINGS ({count} warnings).
REVIEW.md: .jdi/phases/{NN-slug}/REVIEW.md
Next: /jdi-ship {N} (or fix first)
```

**BLOCKED:**
```
Phase {N}: BLOCKED ({count} blockers). REVIEW.md: .jdi/phases/{NN-slug}/REVIEW.md
Fix → /jdi-do {N} → /jdi-verify {N}
```

</process>

<gates>
- pre: SUMMARY.md exists + reviewer registered in .jdi/reviewers.md
- post: REVIEW.md created + STATE updated
</gates>

<errors>
- Reviewer missing -> /jdi-bootstrap
- SUMMARY missing -> /jdi-do
- Reviewer fails -> show error, keep state, suggest retry
</errors>
