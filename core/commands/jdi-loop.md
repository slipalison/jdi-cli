---
name: jdi-loop
description: Ralph loop — orchestrates auto dev↔review until APPROVED verdict. 5 iter cap, human gate + reset (max 3 resets = 15 iter absolute). Oscillation detection cuts dead loop early. Accepts slug or position.
argument_hint: "<slug|position> [--max-iter=5] [--max-resets=3]"
runtime_intent:
  invokes_agent: dynamic
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, edit, grep, glob, terminal]
  opencode:
    subtask: true
  antigravity:
    triggers:
      - "/jdi-loop"
      - "ralph loop"
      - "auto review"
---

<objective>
Runs the `/jdi-do <phase>` → `/jdi-verify <phase>` cycle in loop until APPROVED or APPROVED_WITH_WARNINGS verdict, with no human action between iters. Absolute cap: 5 iter per round + max 3 resets (15 iter total). Ask user before resetting.

Ralph pattern (Huntley + ASDLC):
- Generator/Judge separation (doer writes, reviewer reads)
- Bounded iteration (explicit cap)
- Objective exit criteria (REVIEW.md APPROVED verdict)
- Context rotation (each Agent spawn = fresh context)
- State persistence (LOOP.md + git commits)
- Oscillation detection (finding hash compare)
</objective>

<arguments>
- `phase_id` (required): canonical slug, legacy slug, or integer position
- `--max-iter=N` (optional, default 5): iter per round before human gate
- `--max-resets=N` (optional, default 3): reset rounds before kill switch
- `--reset-loop` (optional): archive a `killed` LOOP.md and start fresh. Requires explicit confirmation — this is a deliberate human decision after revisiting PLAN.md/CONTEXT.md, not a cap bypass.
</arguments>

<process>

### Step 1: Validation

```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new."; exit 1; }
# STATE.md is an untracked advisory cache — absence is normal on a fresh clone
[ -f .jdi/STATE.md ] || echo "note: STATE.md absent — will be rewritten by the loop."

# Specialists registered
ls .jdi/agents/jdi-doer-*.md 2>/dev/null | head -1 || { echo "Doer missing. /jdi-bootstrap."; exit 1; }
ls .jdi/agents/jdi-reviewer-*.md 2>/dev/null | head -1 || { echo "Reviewer missing. /jdi-bootstrap."; exit 1; }
```

### Step 2: Resolve phase

```bash
RESOLVED="$(npx -y jdi-cli resolve-phase "$1")" || { echo "Phase '$1' not found."; exit 1; }
eval "$RESOLVED"
PHASE_SLUG="$JDI_PHASE_SLUG"
PHASE_DIR="$JDI_PHASE_DIR"
PHASE_POSITION="$JDI_PHASE_POSITION"

# PLAN exists
test -f "$PHASE_DIR/PLAN.md" || { echo "PLAN missing for phase $PHASE_SLUG. /jdi-plan $PHASE_SLUG."; exit 1; }
```

### Step 3: Initialize or resume LOOP.md

Path: `$PHASE_DIR/LOOP.md`

```bash
LOOP_FILE="$PHASE_DIR/LOOP.md"

if [ ! -f "$LOOP_FILE" ]; then
  cat > "$LOOP_FILE" <<EOF
---
phase_slug: $PHASE_SLUG
phase_position: $PHASE_POSITION
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
- Terminal states:
  - `status == converged` → abort: "Phase already converged. /jdi-ship $PHASE_SLUG"
  - `status == killed` → abort: "Hard cap reached. Plan needs human review."
    Recovery path: after revisiting PLAN.md/CONTEXT.md, re-run with `--reset-loop`.
    With the flag, confirm via AskUserQuestion, then `mv LOOP.md LOOP.md.killed-{ts}`
    (audit preserved) and initialize a fresh LOOP.md. Without the flag, killed is final.
- Resumable states (continue — go back to running):
  - `status == escalated` or `status == paused` → resuming CONSUMES A RESET:
    run the same reset accounting as Step 5 (`total_resets++`; if it reaches
    `max_resets` → status: killed, abort). Otherwise: `iter: 0`,
    `status: running`, append marker `--- RESUMED from {state} at {ts}
    (reset {total_resets}/{max_resets}) ---` in history. Continue loop.
    (Without this, abort→re-run would zero `iter` for free and bypass the
    absolute hard cap.)
- Active state:
  - `status == running` → resume from current iter (session crash mid-loop case; does NOT consume a reset)

### Step 3.5: Resolve specialists

Single-stack shortcut (first registered pair). Multi-stack projects: Step A
dispatches per-task specialists exactly like `/jdi-do` Step 3, and Step B
chains reviewers exactly like `/jdi-verify` Step 3 — the variables below are
the single-stack fast path.

```bash
DOER=$(grep -oE 'jdi-doer-[a-z0-9-]+' .jdi/specialists.md | head -1)
REVIEWER=$(grep -oE 'jdi-reviewer-[a-z0-9-]+' .jdi/reviewers.md | head -1)
[ -n "$DOER" ] || { echo "No doer registered in .jdi/specialists.md. /jdi-bootstrap."; exit 1; }
[ -n "$REVIEWER" ] || { echo "No reviewer registered in .jdi/reviewers.md. /jdi-bootstrap."; exit 1; }
```

### Step 4: Main loop

```
loop:
  iter++

  # --- Step A: dispatch doer ---
  Agent(
    subagent_type=$DOER,
    description="Loop iter {iter} doer phase $PHASE_SLUG",
    prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, mode=ralph_loop, iter={iter}"
  )

  # --- Step B: dispatch reviewer ---
  Agent(
    subagent_type=$REVIEWER,
    description="Loop iter {iter} reviewer phase $PHASE_SLUG",
    prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, mode=verify, iter={iter}"
  )

  # --- Step C: parse verdict ---
  REVIEW_FILE="$PHASE_DIR/REVIEW.md"
  test -f "$REVIEW_FILE" || { echo "REVIEW.md not created at iter {iter}"; exit 1; }

  # Worst-case across all verdict lines (multi-stack); legacy "Veredicto:" accepted
  VERDICTS=$(grep -oE '(Verdict|Veredicto):\*\* (APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED)' "$REVIEW_FILE" | awk '{print $2}')
  [ -n "$VERDICTS" ] || { echo "No verdict in REVIEW.md at iter {iter} (corrupt review)."; exit 1; }
  if echo "$VERDICTS" | grep -qx 'BLOCKED'; then VERDICT=BLOCKED
  elif echo "$VERDICTS" | grep -qx 'APPROVED_PENDING_MANUAL'; then VERDICT=APPROVED_PENDING_MANUAL
  elif echo "$VERDICTS" | grep -qx 'APPROVED_WITH_WARNINGS'; then VERDICT=APPROVED_WITH_WARNINGS
  else VERDICT=APPROVED
  fi

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
  COMMIT_SHA=$(git rev-parse --short HEAD)
  cat >> "$LOOP_FILE" <<EOF
- iter $iter: $VERDICT, hash=$FINDING_HASH, commit=$COMMIT_SHA, ts=$(date -Iseconds)
EOF

  # Update frontmatter (iter, status) — sed/awk substitute "iter:" line

  # --- Step F: convergence check ---
  if [ "$VERDICT" = "APPROVED" ] || [ "$VERDICT" = "APPROVED_WITH_WARNINGS" ]; then
    Update LOOP.md frontmatter -> status: converged
    Update STATE.md -> current_phase_slug: $PHASE_SLUG, phase_status: verified, phase_verdict: $VERDICT, next_step: /jdi-ship $PHASE_SLUG
    git add "$PHASE_DIR/LOOP.md"; git add .jdi/STATE.md 2>/dev/null || true
    git commit -m "chore($PHASE_SLUG): loop converged at iter $iter ($VERDICT)"
    echo "Phase $PHASE_SLUG converged at iter $iter. Verdict: $VERDICT"
    echo "Next: /jdi-ship $PHASE_SLUG"
    exit 0
  fi

  # Auto gates passed but manual DoD items await a human — the loop cannot
  # confirm them. Exit cleanly routing to /jdi-confirm-dod (NOT convergence
  # to ship; ship would refuse anyway).
  if [ "$VERDICT" = "APPROVED_PENDING_MANUAL" ]; then
    Update LOOP.md frontmatter -> status: converged
    Update STATE.md -> phase_status: pending_manual_dod, phase_verdict: APPROVED_PENDING_MANUAL, next_step: /jdi-confirm-dod $PHASE_SLUG
    git add "$PHASE_DIR/LOOP.md"; git add .jdi/STATE.md 2>/dev/null || true
    git commit -m "chore($PHASE_SLUG): loop converged at iter $iter (pending manual DoD)"
    echo "Phase $PHASE_SLUG: auto gates green at iter $iter; manual DoD items pending."
    echo "Next: /jdi-confirm-dod $PHASE_SLUG"
    exit 0
  fi

  # --- Step G: oscillation detection (early-escalate) ---
  # Compare against ALL hashes of the current round (since the last RESET/
  # RESUMED marker), not just the previous iter — catches period-2 cycles
  # (A/B/A/B) that a single-step compare misses.
  ROUND_HASHES=$(awk '
    /^--- (RESET|RESUMED)/ { delete seen; n=0; next }
    /^- iter [0-9]+:/ { if (match($0, /hash=[a-f0-9]+/)) { n++; seen[n] = substr($0, RSTART+5, RLENGTH-5) } }
    END { for (i = 1; i < n; i++) print seen[i] }   # exclude the current iter (last line)
  ' "$LOOP_FILE")

  if [ -n "$ROUND_HASHES" ] && echo "$ROUND_HASHES" | grep -qx "$FINDING_HASH"; then
    AskUserQuestion(
      question="Oscillation detected on phase $PHASE_SLUG. Iter $iter repeats a finding hash already seen this round ($FINDING_HASH). Loop not progressing. What now?",
      options=[
        "Continue (reset counter, 5 more iter)" => continue_with_reset,
        "Abort loop (status=escalated, stays in REVIEW.md)" => abort,
        "Adjust plan (status=paused, edit PLAN.md/CONTEXT.md, re-run /jdi-loop $PHASE_SLUG)" => pause
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
      question="Phase $PHASE_SLUG: $iter iter without APPROVED. Cost grows. What now?",
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

  continue
```

### Step 5: Reset logic

```
reset_logic:
  total_resets++

  if [ "$total_resets" -ge "${MAX_RESETS:-3}" ]; then
    Update LOOP.md -> status: killed
    Update STATE.md -> phase_status: blocked, phase_verdict: BLOCKED, next_step: human review of PLAN.md/CONTEXT.md (loop killed)
    git add "$PHASE_DIR/LOOP.md"; git add .jdi/STATE.md 2>/dev/null || true
    git commit -m "chore($PHASE_SLUG): loop killed (3 resets, $((iter * total_resets)) iter total)"
    echo "Hard cap reached. Loop killed."
    exit 1
  fi

  iter=0
  Update LOOP.md frontmatter -> iter: 0, total_resets: $total_resets
  Append in LOOP.md history: "--- RESET $total_resets at $(date -Iseconds) ---"
  goto loop
```

### Step 6: Abort logic

```
abort_logic:
  Update LOOP.md -> status: escalated
  Update STATE.md -> phase_status: blocked, phase_verdict: BLOCKED, next_step: review REVIEW.md, fix manually or /jdi-loop $PHASE_SLUG to resume
  git add "$PHASE_DIR/LOOP.md"; git add .jdi/STATE.md 2>/dev/null || true
  git commit -m "chore($PHASE_SLUG): loop aborted at iter $iter (user escalated)"
  exit 0
```

### Step 7: Pause logic

```
pause_logic:
  Update LOOP.md -> status: paused
  Update STATE.md -> phase_status: paused, next_step: edit PLAN.md/CONTEXT.md and re-run /jdi-loop $PHASE_SLUG
  git add "$PHASE_DIR/LOOP.md"; git add .jdi/STATE.md 2>/dev/null || true
  git commit -m "chore($PHASE_SLUG): loop paused at iter $iter (plan adjustment)"
  exit 0
```

(All four terminal transitions — converged, killed, escalated, paused — commit
LOOP.md (+ STATE.md only on legacy projects that still track it; on 0.3.0+
projects STATE.md is an untracked cache); the working tree is never left
dirty by the loop itself.)

### Step 8: Final confirmation (convergence)

```
Phase $PHASE_SLUG: converged at $iter iter (resets: $total_resets). Verdict: $VERDICT.
LOOP.md + REVIEW.md in $PHASE_DIR
Next: /jdi-ship $PHASE_SLUG
```

</process>

<gates>
- pre: PLAN.md + doer + reviewer registered in specialists.md/reviewers.md
- post: final status in LOOP.md ∈ {converged, escalated, paused, killed} + STATE updated
- invariant: each iter = doer commit + reviewer commit (granular audit trail)
</gates>

<errors>
- Doer/reviewer missing → /jdi-bootstrap
- PLAN missing → /jdi-plan
- LOOP.md corrupted (invalid frontmatter) → backup to LOOP.md.bak, recreate from scratch
- REVIEW.md not created by reviewer → exit 1 with error
- No changes in working dir after doer iter → warn, continue
</errors>

<rules>
- NEVER skip human gate when iter >= max_iter or oscillation detected
- NEVER reset total_resets — only iter. Resuming from escalated/paused CONSUMES a reset (crash-resume of status running does not).
- LOOP.md history is APPEND-ONLY
- Reviewer remains read-only always — doer is the only writer
- Each iter produces atomic commits; every terminal transition commits LOOP.md + STATE.md
- Absolute hard cap = max_iter * max_resets (default 15) — non-negotiable kill switch. The only way past `killed` is the explicit `--reset-loop` flag (confirmed, audited via LOOP.md.killed-{ts}).
</rules>

<runtime_notes>

**Claude Code:** full loop as specified — sequential Agent() spawns per iter, fresh context each.

**Copilot:** subagent spawning has no reliable completion signal. Run the loop
body inline instead: execute /jdi-do steps, then /jdi-verify steps, in this
same session, one iter at a time. Caps/oscillation/human gates unchanged.

**OpenCode/Antigravity:** use the runtime's native Task/spawn if available;
otherwise inline like Copilot.

**Orchestration mode:** the loop itself IS the standard path — it never adds
extra fan-out beyond doer/reviewer, so `orchestration.mode` (standard or
enhanced) requires no branching here. The reviewer's enhanced DoD critic runs
inside /jdi-verify semantics when configured.
</runtime_notes>

<references>
- Ralph Wiggum technique (ghuntley.com/ralph)
- ASDLC Ralph Loop pattern (asdlc.io/patterns/ralph-loop)
- Convergence: P(C) = 1 - (1 - p_success)^n
</references>
