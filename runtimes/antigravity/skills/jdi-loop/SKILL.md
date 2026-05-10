---
name: jdi-loop
description: Ralph loop — orchestrates auto dev↔review until APPROVED verdict. 5 iter cap, human gate + reset (max 3 resets = 15 iter absolute). Oscillation detection cuts dead loop early.
argument_hint: "<phase_number> [--max-iter=5] [--max-resets=3]"
runtime_intent:
  invokes_agent: dynamic
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, edit, grep, glob, terminal]
  opencode:
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-loop"
      - "ralph loop phase {N}"
      - "auto review phase {N}"
---

<objective>
Runs the `/jdi-do {N}` -> `/jdi-verify {N}` cycle in loop until APPROVED or APPROVED_WITH_WARNINGS verdict, with no human action between iters. Absolute cap: 5 iter per round + max 3 resets (15 iter total). Ask user before resetting.

Ralph pattern (Huntley + ASDLC):
- Generator/Judge separation (doer writes, reviewer reads)
- Bounded iteration (explicit cap)
- Objective exit criteria (REVIEW.md APPROVED verdict)
- Context rotation (each Agent spawn = fresh context)
- State persistence (LOOP.md + git commits)
- Oscillation detection (finding hash compare)
</objective>

<arguments>
- `phase_number` (required)
- `--max-iter=N` (optional, default 5): iter per round before human gate
- `--max-resets=N` (optional, default 3): reset rounds before kill switch
</arguments>

<process>

### Step 1: Validation

```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new."; exit 1; }
test -f .jdi/STATE.md || { echo "STATE.md missing."; exit 1; }

# Specialists registered
ls .jdi/agents/jdi-doer-*.md 2>/dev/null | head -1 || {
  echo "Doer missing. /jdi-bootstrap."; exit 1;
}
ls .jdi/agents/jdi-reviewer-*.md 2>/dev/null | head -1 || {
  echo "Reviewer missing. /jdi-bootstrap."; exit 1;
}

# PLAN exists
ls .jdi/phases/{NN}*/PLAN.md 2>/dev/null || {
  echo "PLAN missing for phase {N}. /jdi-plan {N}."; exit 1;
}
```

### Step 2: Initialize or resume LOOP.md

Path: `.jdi/phases/{NN-slug}/LOOP.md`

```bash
LOOP_FILE=".jdi/phases/{NN-slug}/LOOP.md"

if [ ! -f "$LOOP_FILE" ]; then
  cat > "$LOOP_FILE" <<EOF
---
phase: {N}
iter: 0
total_resets: 0
status: running
max_iter_per_round: ${MAX_ITER:-5}
max_resets: ${MAX_RESETS:-3}
created_at: $(date -Iseconds)
---

## History

EOF
fi
```

If already exists:
- Read `iter`, `total_resets`, `status` from frontmatter
- Terminal states (abort):
  - `status == converged` -> abort: "Phase already converged. /jdi-ship {N}"
  - `status == killed` -> abort: "Hard cap reached. Plan needs human review."
- Resumable states (continue — go back to running):
  - `status == escalated` -> reset `iter: 0`, `status: running`, `total_resets` preserved, append marker `--- RESUMED from escalated at {ts} ---` in history. Continue loop.
  - `status == paused` -> reset `iter: 0`, `status: running`, `total_resets` preserved, append marker `--- RESUMED from paused at {ts} ---` in history. Continue loop.
- Active state:
  - `status == running` -> resume from current iter (session crash mid-loop case)

### Step 3: Main loop

```
loop:
  iter++

  # --- Step A: dispatch doer ---
  Agent(
    subagent_type=$DOER,
    description="Loop iter {iter} doer phase {N}",
    prompt="phase={N}, mode=ralph_loop, iter={iter}"
  )

  # Doer detects ralph mode via presence of LOOP.md + REVIEW.md (Step 1 of specialist).
  # If REVIEW.md verdict=BLOCKED, focuses on fixing blockers.

  # --- Step B: dispatch reviewer ---
  Agent(
    subagent_type=$REVIEWER,
    description="Loop iter {iter} reviewer phase {N}",
    prompt="phase={N}, mode=verify, iter={iter}"
  )

  # --- Step C: parse verdict ---
  REVIEW_FILE=".jdi/phases/{NN-slug}/REVIEW.md"
  test -f "$REVIEW_FILE" || { echo "REVIEW.md not created at iter {iter}"; exit 1; }

  VERDICT=$(grep -oE 'Verdict:\*\* (APPROVED|APPROVED_WITH_WARNINGS|BLOCKED)' "$REVIEW_FILE" | awk '{print $2}')

  # --- Step D: hash findings (oscillation detection) ---
  FINDING_BODY=$(awk '
    /^## Blockers/ { flag=1; next }
    /^## Warnings/ { flag=1; next }
    /^## / { flag=0 }
    flag { print }
  ' "$REVIEW_FILE")

  FINDING_HASH=$(echo "$FINDING_BODY" | sed 's/[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T[^ ]*//g' | tr '[:upper:]' '[:lower:]' | grep -v '^[[:space:]]*$' | sort -u | sha256sum | cut -c1-12)
  [ -z "$FINDING_HASH" ] && FINDING_HASH=$(echo -n "" | sha256sum | cut -c1-12)

  # --- Step E: append history to LOOP.md ---
  # Append line in ## History of LOOP.md:
  #   - iter {N}: {VERDICT}, hash={HASH}, commit={SHA}, ts={ISO}

  COMMIT_SHA=$(git rev-parse --short HEAD)
  cat >> "$LOOP_FILE" <<EOF
- iter $iter: $VERDICT, hash=$FINDING_HASH, commit=$COMMIT_SHA, ts=$(date -Iseconds)
EOF

  # Update frontmatter (iter, status)
  # ... sed/awk substitute "iter:" line in frontmatter

  # --- Step F: convergence check ---
  if [ "$VERDICT" = "APPROVED" ] || [ "$VERDICT" = "APPROVED_WITH_WARNINGS" ]; then
    # converged
    Update LOOP.md frontmatter -> status: converged
    Update STATE.md -> phase_status: verified, phase_verdict: $VERDICT, next_step: /jdi-ship {N}
    git add .jdi/phases/{NN-slug}/LOOP.md .jdi/STATE.md
    git commit -m "chore({phase-slug}): loop converged at iter $iter ($VERDICT)"
    echo "Phase {N} converged at iter $iter. Verdict: $VERDICT"
    echo "Next: /jdi-ship {N}"
    exit 0
  fi

  # --- Step G: oscillation detection (early-escalate) ---
  # Compare FINDING_HASH with previous iter's hash
  # Guard: need >=2 iter lines in LOOP.md history to compare
  ITER_COUNT=$(grep -cE '^- iter [0-9]+:' "$LOOP_FILE")
  if [ "$ITER_COUNT" -ge 2 ]; then
    PREV_HASH=$(grep -E '^- iter [0-9]+:' "$LOOP_FILE" | tail -2 | head -1 | grep -oE 'hash=[a-f0-9]+' | cut -d= -f2)
  else
    PREV_HASH=""
  fi

  if [ -n "$PREV_HASH" ] && [ "$FINDING_HASH" = "$PREV_HASH" ]; then
    AskUserQuestion(
      question="Oscillation detected on phase {N}. Iter $iter and $((iter-1)) have SAME finding hash ($FINDING_HASH). Loop not progressing. What now?",
      options=[
        "Continue (reset counter, 5 more iter)" => continue_with_reset,
        "Abort loop (status=escalated, stays in REVIEW.md)" => abort,
        "Adjust plan (status=paused, you edit PLAN.md/CONTEXT.md, re-run /jdi-loop {N})" => pause
      ]
    )

    case answer:
      continue_with_reset: goto reset_logic
      abort: goto abort_logic
      pause: goto pause_logic
  fi

  # --- Step H: cap check ---
  if [ "$iter" -ge "${MAX_ITER:-5}" ]; then
    AskUserQuestion(
      question="Phase {N}: $iter iter without APPROVED. Cost grows. What now?",
      options=[
        "Continue (reset counter, ${MAX_ITER:-5} more iter)" => continue_with_reset,
        "Abort (status=escalated)" => abort,
        "Adjust plan (status=paused)" => pause
      ]
    )

    case answer:
      continue_with_reset: goto reset_logic
      abort: goto abort_logic
      pause: goto pause_logic
  fi

  # otherwise, next iter
  continue
```

### Step 4: Reset logic

```
reset_logic:
  total_resets++

  if [ "$total_resets" -ge "${MAX_RESETS:-3}" ]; then
    # Absolute kill switch
    Update LOOP.md -> status: killed
    Update STATE.md -> phase_status: blocked, phase_verdict: BLOCKED, next_step: human review of PLAN.md/CONTEXT.md (loop killed)
    git add .jdi/phases/{NN-slug}/LOOP.md .jdi/STATE.md
    git commit -m "chore({phase-slug}): loop killed (3 resets, $((iter * total_resets)) iter total)"
    echo "Hard cap reached (${MAX_RESETS:-3} resets). Loop killed."
    echo "Action: manually review PLAN.md or CONTEXT.md. Maybe fragment phase."
    exit 1
  fi

  # Reset counter, history append-only
  iter=0
  Update LOOP.md frontmatter -> iter: 0, total_resets: $total_resets
  Append in LOOP.md history: "--- RESET $total_resets at $(date -Iseconds) ---"
  echo "Reset $total_resets/${MAX_RESETS:-3}. New round of ${MAX_ITER:-5} iter."
  goto loop
```

### Step 5: Abort logic

```
abort_logic:
  Update LOOP.md -> status: escalated
  Update STATE.md -> phase_status: blocked, phase_verdict: BLOCKED, next_step: review REVIEW.md, fix manually or /jdi-loop {N} to resume
  git add .jdi/phases/{NN-slug}/LOOP.md .jdi/STATE.md
  git commit -m "chore({phase-slug}): loop aborted at iter $iter (user escalated)"
  echo "Loop aborted. REVIEW.md has latest findings."
  echo "Re-run /jdi-loop {N} to resume (status returns to running automatically)."
  exit 0
```

### Step 6: Pause logic

```
pause_logic:
  Update LOOP.md -> status: paused
  Update STATE.md -> phase_status: paused, next_step: edit PLAN.md/CONTEXT.md and re-run /jdi-loop {N}
  echo "Loop paused. Edit PLAN.md or CONTEXT.md."
  echo "When ready: /jdi-loop {N}. Will resume with status=running, iter=0, same total_resets."
  exit 0
```

### Step 7: Final confirmation (convergence)

```
Phase {N}: converged at $iter iter (resets: $total_resets). Verdict: $VERDICT.
LOOP.md + REVIEW.md in .jdi/phases/{NN-slug}/
Next: /jdi-ship {N}
```

</process>

<gates>
- pre: PLAN.md + doer + reviewer registered in specialists.md/reviewers.md
- post: final status in LOOP.md ∈ {converged, escalated, paused, killed} + STATE updated
- invariant: each iter = doer commit + reviewer commit (granular audit trail)
</gates>

<errors>
- Doer/reviewer missing -> /jdi-bootstrap
- PLAN missing -> /jdi-plan
- LOOP.md corrupted (invalid frontmatter) -> backup to LOOP.md.bak, recreate from scratch
- REVIEW.md not created by reviewer -> exit 1 with error
- No changes in working dir after doer iter (doer did nothing) -> warn, but continue (reviewer may still find uncorrected previous issues)
</errors>

<runtime_notes>

**Claude Code:**
- Native AskUserQuestion for human gate
- Sequential Agent dispatch inside the loop (does not parallelize doer+reviewer — sequential by design)

**Copilot:**
- No native AskUserQuestion — use question in main chat and wait for answer before proceeding
- Loop control inline in command body (orchestrator = Copilot's main thread)

**OpenCode:**
- subtask: true for subagent dispatch
- Human gate question via main prompt

**Antigravity:**
- Skill discovered by trigger ("ralph loop phase 2", "auto review phase 2")
- AskUserQuestion via skill prose (ask + wait for text answer)
- Loop control inline in skill body
</runtime_notes>

<rules>
- NEVER skip human gate when iter >= max_iter or oscillation detected — controlled cost is invariant
- NEVER reset total_resets — only iter
- LOOP.md history is APPEND-ONLY (audit trail, never erase)
- Reviewer remains read-only always — doer is the only writer
- Each iter produces atomic commits (granularity preserved)
- Absolute hard cap = max_iter * max_resets (default 15) — non-negotiable kill switch
</rules>

<references>
- Ralph Wiggum technique (ghuntley.com/ralph)
- ASDLC Ralph Loop pattern (asdlc.io/patterns/ralph-loop)
- Convergence: P(C) = 1 - (1 - p_success)^n
</references>
