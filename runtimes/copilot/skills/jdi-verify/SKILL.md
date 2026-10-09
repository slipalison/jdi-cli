---
name: jdi-verify
description: Runs phase quality gates via reviewer specialist. Build, tests, coverage, lint, security checks, UI validation, Definition of Done. Verdict APPROVED / APPROVED_WITH_WARNINGS / APPROVED_PENDING_MANUAL / BLOCKED. Accepts slug or position.
argument_hint: "<slug|position> [--full]"
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
- `--full` (optional): run every reviewer even when an untouched one could be carried (multi-stack incremental verify). Sets `FULL=1`.
</arguments>

<process>

### Step 1: Validation

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y jdi-cli@0.18.1 render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).
```bash
test -d .jdi/ || { echo "Not a JDI project."; exit 1; }

# Verify reviewer exists
ls .jdi/agents/jdi-reviewer-*.md 2>/dev/null | head -1 || {
  echo "Reviewer missing. /jdi-bootstrap."
  exit 1
}

# Runtime copies: Agent(subagent_type=...) resolves from .claude/agents/ (etc.),
# never from .jdi/agents/. Self-heal a fresh clone or a stale copy before the
# first spawn (byte-deterministic; no-op when already in sync).
npx -y jdi-cli@0.18.1 sync-specialists --check --quiet || npx -y jdi-cli@0.18.1 sync-specialists --quiet
```

### Step 2: Resolve phase

```bash
RESOLVED="$(npx -y jdi-cli@0.18.1 resolve-phase "$1")" || { echo "Phase '$1' not found."; exit 1; }
eval "$RESOLVED"
PHASE_SLUG="$JDI_PHASE_SLUG"
PHASE_DIR="$JDI_PHASE_DIR"
PHASE_POSITION="$JDI_PHASE_POSITION"

# Verify phase was executed
test -f "$PHASE_DIR/SUMMARY.md" || {
  echo "Phase $PHASE_SLUG not executed. /jdi-do $PHASE_SLUG."
  exit 1
}

```

### Step 3: Resolve reviewer specialist(s)

```bash
REVIEWERS=$(grep -oE 'jdi-reviewer-[a-z0-9-]+' .jdi/reviewers.md | sort -u)
REVIEWER_COUNT=$(echo "$REVIEWERS" | wc -l)
echo "Reviewers registered: $REVIEWER_COUNT"
```

**Single-stack** (`REVIEWER_COUNT == 1`): one reviewer, normal flow.
**Multi-stack** (`REVIEWER_COUNT > 1`): chain reviewers in registry order. Each writes its own REVIEW segment; aggregate verdict = worst-case (1 BLOCK = overall BLOCK).

### Step 4: Measure the gates, then spawn reviewer(s)

REVIEW.md is a per-run artifact — regenerated so stale verdicts from a
previous run can never poison the worst-case aggregation (git history keeps
every prior run; each verify commits its REVIEW.md). Which reviewers run is one
call:

```bash
RPLAN=$(npx -y jdi-cli@0.18.1 review plan "$PHASE_SLUG" --reviewers "$REVIEWERS" ${FULL:+--full})   # JSON: mode, run, carry, reasons
RUN=<the `run` list of RPLAN, in order>
```

It removes REVIEW.md. Multi-stack only (`economy.incremental_verify`, on by
default): the FIRST reviewer always runs (it owns the DoD Checklist); another
reviewer is CARRIED — its last segment kept, no spawn, no gates — only when
nothing in its scope nor in this phase's CONTEXT/PLAN changed since its last
run and that segment was not BLOCKED. `--full` (this command's flag) runs
everyone. Single-stack: always one full run.

**4a. Gates outside the agents' context** (when `.jdi/stacks/` exists —
`jdi-cli template stack` shows the format; without it, reviewers run their
own gates as before). Build, tests (once — inside coverage when the stack says
so), coverage and lint per stack, and the automatic DoD rows ONCE for the whole
phase. Long suites run here, in this shell, not inside a large reviewer context
waiting on them:

```bash
if [ -d .jdi/stacks ]; then
  npx -y jdi-cli@0.18.1 gates run "$PHASE_SLUG" --only dod          # DoD once (E2E/real-login rows: EVIDENCE, never executed)
  for REVIEWER in $RUN; do                                       # carried reviewers: no gates
    npx -y jdi-cli@0.18.1 gates run "$PHASE_SLUG" --stack "$REVIEWER"
  done
fi
```

A failing gate does not stop the step: the results go into the JSON the
reviewers read; the verdict comes from the reviewers.

**4b. One brief per reviewer** (scope + changed files, gate results, tasks,
DoD, decisions for Gate 6, known errors):

```bash
BRIEF_R=$(npx -y jdi-cli@0.18.1 brief "$PHASE_SLUG" --role reviewer --stack "$REVIEWER" --runtime other | cut -d' ' -f1)
```

**Single-stack:**
```
Agent(
  subagent_type="${REVIEWERS}",
  description="Verify phase $PHASE_SLUG",
  prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, mode=verify, dod_owner=true, brief=$BRIEF_R"
)
```

**Multi-stack:** spawn each reviewer of `$RUN` in sequence (NOT parallel — build/test commands may conflict on ports, locks, output dirs). The FIRST reviewer owns the DoD Checklist (`dod_owner=true`); the others reference it — the DoD is evaluated once, not once per reviewer:

```
for REVIEWER in $RUN:
  Agent(
    subagent_type="$REVIEWER",
    description="Verify phase $PHASE_SLUG ($REVIEWER)",
    prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, mode=verify, reviewer_segment=$REVIEWER, dod_owner=<true for the first>, brief=$BRIEF_R"
  )
  # Each reviewer appends to $PHASE_DIR/REVIEW.md under section
  # "## Reviewer: $REVIEWER" with its own gate results and verdict
```

Then, always (single- and multi-stack): put the carried segments back (if any) and stamp the verified
commit in REVIEW.md (`<!-- jdi:verified head=… -->` — `/jdi-ship` refuses a
review older than the code):

```bash
npx -y jdi-cli@0.18.1 review merge "$PHASE_SLUG"
```

Each reviewer scopes its gates to its `file_glob` (from frontmatter `scope.file_glob`). Coverage threshold enforced only on files matching the glob.

Reviewers are read-only (they write only their REVIEW.md segment). Wait for
completion before next. Each returns a short verdict line (return contract):
do not open REVIEW.md to repeat it — Step 5 reads the verdicts mechanically.
The dispatch prompt is the line above, nothing more: no reading lists, no
plan text.


### Step 4.5: DoD proof checks — bait, then the critic (lean cadence)

Gate 8 maps `exit 0 → PASS` for automatic DoD rows. A command can exit 0
without proving its criterion (a grep on text that already exists, a test that
asserts nothing). These checks can only make the verdict **stricter**.

**Bait (mechanical, any runtime).** Rows that carry a `Bait:` (a mutation that
breaks the criterion) are checked in a throwaway worktree at HEAD: the Verify
must pass, then fail once the Bait is applied. A CAUGHT row is not re-run until
its proof changes.

```bash
npx -y jdi-cli@0.18.1 dod bait "$PHASE_SLUG"      # no-op when no row has a Bait
```

**Critic (judgment).** Runs when this runtime can spawn sub-agents AND the
critic is on: `orchestration.mode == "enhanced"`, or the invoking orchestrator
passed `critic=on` (`/jdi-issue`). `economy.critic: "off"` turns it off; a
LITE phase (`jdi-cli size`) skips it unless `critic=on`. Lean cadence: only
rows never examined, rows whose proof changed and rows found hollow last time
— not rows already sound, bait-checked, failing (a defect, not a hollow pass)
or whose hollow-proof block the loop already spent (such a row is looked at
once more after the block — it may have been fixed — and can no longer block).
(`economy.critic: "every_verify"` re-examines every row each time.)

```bash
CRIT=$(npx -y jdi-cli@0.18.1 critic plan "$PHASE_SLUG" --runtime claude)   # JSON: rows, brief, skip
```

`rows` non-empty → spawn ONE critic, sequential, never in the background:

```
Agent(
  subagent_type="jdi-dod-critic",
  description="DoD critic $PHASE_SLUG",
  prompt="phase_slug=$PHASE_SLUG, brief=<brief from CRIT>"
)
```


Then fold the results in — always, even when the critic did not run (a Bait
that survived is an objective hollow proof):

```bash
npx -y jdi-cli@0.18.1 critic apply "$PHASE_SLUG"
```

`apply` is the only writer of the `## DoD Critic` segment of REVIEW.md: objective
hollow proofs → `[hollow DoD N]` blockers and a BLOCKED line; suspicions and
rows whose block the loop already spent → warnings. The critic itself writes
only its findings file and returns one line; a failed or silent critic changes
nothing (fail-open — the deterministic gates already ran).

### Step 5: Read aggregate verdict

```bash
test -f "$PHASE_DIR/REVIEW.md" || { echo "REVIEW.md not created"; exit 1; }
# Worst case across every segment (BLOCKED > PENDING_MANUAL > WITH_WARNINGS >
# APPROVED); exit 2 = no verdict line (malformed — never ship on silence).
VERDICT=$(npx -y jdi-cli@0.18.1 review verdict "$PHASE_SLUG") || { echo "Reviewer wrote no verdict line — REVIEW.md malformed. Aborting."; exit 1; }
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
