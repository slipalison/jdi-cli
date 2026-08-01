---
name: jdi-verify
description: Runs phase quality gates via reviewer specialist. Build, tests, coverage, lint, security checks, UI validation, Definition of Done. Verdict APPROVED / APPROVED_WITH_WARNINGS / APPROVED_PENDING_MANUAL / BLOCKED. Accepts slug or position.
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

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y jdi-cli render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).
```bash
test -d .jdi/ || { echo "Not a JDI project."; exit 1; }

# Verify reviewer exists
ls .jdi/agents/jdi-reviewer-*.md 2>/dev/null | head -1 || {
  echo "Reviewer missing. /jdi-bootstrap."
  exit 1
}
```

### Step 2: Resolve phase

```bash
RESOLVED="$(npx -y jdi-cli resolve-phase "$1")" || { echo "Phase '$1' not found."; exit 1; }
eval "$RESOLVED"
PHASE_SLUG="$JDI_PHASE_SLUG"
PHASE_DIR="$JDI_PHASE_DIR"
PHASE_POSITION="$JDI_PHASE_POSITION"

# Verify phase was executed
test -f "$PHASE_DIR/SUMMARY.md" || {
  echo "Phase $PHASE_SLUG not executed. /jdi-do $PHASE_SLUG."
  exit 1
}

# Context budget warm-up
npx -y jdi-cli monitor .jdi/PROJECT.md .jdi/DECISIONS.md "$PHASE_DIR/PLAN.md" "$PHASE_DIR/SUMMARY.md" || true
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

REVIEW.md is a per-run artifact — regenerate it from scratch so stale
verdicts from a previous run can never poison the worst-case aggregation
(git history keeps every prior run; each verify commits its REVIEW.md):

```bash
rm -f "$PHASE_DIR/REVIEW.md"
```

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

### Step 4.5: Enhanced DoD critic (opt-in, capability-gated)

Read `.jdi/config.json`. Run this step if this runtime can spawn read-only sub-agents (`Agent`/`Task` available) AND either **`orchestration.mode == "enhanced"`** OR the invoking orchestrator requested it (`critic=on` — `/jdi-issue` forces this: with no human watching, the critic is the skeptic in the room). Otherwise SKIP entirely — go to Step 5 with `REVIEW.md` untouched. The off-path is byte-identical; this is the "use the resource only when available" contract.

Why: Gate 8 (Definition of Done) maps `exit 0 → PASS` for `Type=Auto` rows with no semantic scrutiny. A command can exit 0 without proving its criterion (a grep on a heading that still exists, a test asserting nothing). This critic re-examines those rows and can only ever make the verdict **stricter** — it can never raise a blocked verdict to approved.

**If it runs:**

1. Spawn ONE read-only critic — single sequential `Agent()` call, never `run_in_background`, never mid-wave, so there is zero `.git/config.lock` exposure. Reuse the project reviewer (already read-only) in critic mode; multi-stack uses the first reviewer (DoD is project-global, evaluated once):

```
CRITIC=$(echo "$REVIEWERS" | head -1)
Agent(
  subagent_type="$CRITIC",
  description="DoD critic phase $PHASE_SLUG",
  prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, mode=dod-critic.
          For every DoD row in REVIEW.md with Type=Auto AND Status=PASS, decide whether the gate
          command PROVES the criterion or merely exits 0. Return findings ONLY as
          [{row, hollow:true|false, objective:true|false, evidence}]. Write nothing to disk."
)
```

2. The critic returns findings; **the orchestrator (this command) is the sole writer.** Append ONE segment to `$PHASE_DIR/REVIEW.md`:

```markdown
## DoD Critic (enhanced)

{for each hollow=true finding: "- DoD row «{row}»: {evidence}"}

**Verdict:** {BLOCKED if any (hollow && objective); APPROVED_WITH_WARNINGS if any (hollow && !objective); otherwise APPROVED}
```

3. Fall through to Step 5 unchanged — its worst-case grep already aggregates this new `**Verdict:**` line (objective disproof → BLOCKED; suspicion → APPROVED_WITH_WARNINGS; clean → no change).

Invariants: critic is read-only and writes nothing itself; orchestrator owns the single `REVIEW.md` write; the segment can only tighten the aggregate; one sequential agent. Fail-open: if the critic errors or returns nothing, treat as APPROVED and proceed — the deterministic gates already ran in Step 4. (The reviewer-specialist template ships a `mode=dod-critic` branch; the prompt above matches its contract.)

### Step 5: Read aggregate verdict

```bash
test -f "$PHASE_DIR/REVIEW.md" || { echo "REVIEW.md not created"; exit 1; }

VERDICTS=$(grep -oE 'Verdict:\*\* (APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED)' "$PHASE_DIR/REVIEW.md" | awk '{print $2}')
[ -n "$VERDICTS" ] || { echo "Reviewer wrote no verdict line — REVIEW.md malformed. Aborting."; exit 1; }

# Worst-case wins: BLOCK > PENDING_MANUAL > WARNINGS > APPROVED
if echo "$VERDICTS" | grep -q BLOCKED; then
  VERDICT=BLOCKED
elif echo "$VERDICTS" | grep -q APPROVED_PENDING_MANUAL; then
  VERDICT=APPROVED_PENDING_MANUAL
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
phase_status: {verified|blocked|pending_manual_dod}
phase_verdict: {APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED}
next_step: {if APPROVED or WITH_WARNINGS: /jdi-ship $PHASE_SLUG; if PENDING_MANUAL: /jdi-confirm-dod $PHASE_SLUG; if BLOCKED: fix and /jdi-do $PHASE_SLUG again}
```

```bash
git add "$PHASE_DIR/REVIEW.md"; git add .jdi/STATE.md 2>/dev/null || true
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

**APPROVED_PENDING_MANUAL:**
```
Phase $PHASE_SLUG: APPROVED_PENDING_MANUAL ({N} DoD manual items pending).
All auto gates passed; manual DoD items need explicit confirmation before ship.
REVIEW.md: $PHASE_DIR/REVIEW.md
Next: /jdi-confirm-dod $PHASE_SLUG
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
