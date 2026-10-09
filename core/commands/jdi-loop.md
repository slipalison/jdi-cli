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

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y {{JDI_CLI}} render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).

```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new."; exit 1; }
# STATE.md is an untracked advisory cache — absence is normal on a fresh clone
[ -f .jdi/STATE.md ] || echo "note: STATE.md absent — will be rewritten by the loop."

# Specialists registered
ls .jdi/agents/jdi-doer-*.md 2>/dev/null | head -1 || { echo "Doer missing. /jdi-bootstrap."; exit 1; }
ls .jdi/agents/jdi-reviewer-*.md 2>/dev/null | head -1 || { echo "Reviewer missing. /jdi-bootstrap."; exit 1; }
# Runtime copies (.claude/agents/ etc. — the runtime never spawns from .jdi/agents/): self-heal before the loop
npx -y {{JDI_CLI}} sync-specialists --check --quiet || npx -y {{JDI_CLI}} sync-specialists --quiet
```

### Step 2: Resolve phase

```bash
RESOLVED="$(npx -y {{JDI_CLI}} resolve-phase "$1")" || { echo "Phase '$1' not found."; exit 1; }
eval "$RESOLVED"
PHASE_SLUG="$JDI_PHASE_SLUG"
PHASE_DIR="$JDI_PHASE_DIR"
PHASE_POSITION="$JDI_PHASE_POSITION"

# PLAN exists
test -f "$PHASE_DIR/PLAN.md" || { echo "PLAN missing for phase $PHASE_SLUG. /jdi-plan $PHASE_SLUG."; exit 1; }
```

### Step 3: Initialize or resume LOOP.md

```bash
npx -y {{JDI_CLI}} loop init "$PHASE_SLUG" --max-iter "${MAX_ITER:-5}" --max-resets "${MAX_RESETS:-3}" >/dev/null
STATUS=$(npx -y {{JDI_CLI}} loop status "$PHASE_SLUG")   # JSON: status, iter, total_resets, hollow_spent
```

- `status` `converged` → abort: "Phase already converged. /jdi-ship $PHASE_SLUG".
- `status` `killed` → abort: "Hard cap reached. Plan needs human review." With
  `--reset-loop` (confirmed via AskUserQuestion): `mv LOOP.md LOOP.md.killed-{ts}`
  (audit preserved) and run `loop init` again. Without the flag, killed is final.
- `status` `escalated` or `paused` → resuming CONSUMES A RESET:
  `npx -y {{JDI_CLI}} loop reset "$PHASE_SLUG" --reason "resumed from <state>"`
  (prints `killed` when the cap is reached → abort). Without this, abort→re-run
  would zero `iter` for free and bypass the absolute hard cap.
- `status` `running` → resume (crash mid-loop; does NOT consume a reset).

LOOP.md is machine-written: frontmatter (`iter`, `total_resets`, `status`,
caps, `hollow_spent`, `last_verified_commit`) plus `## History` lines from
`loop record`. Narrative notes, if any, go under `## Notes` — never into the
history lines (the oscillation check parses them).

### Step 3.5: Resolve specialists

Single-stack shortcut (first registered pair). Multi-stack projects: Step A
dispatches per-task specialists exactly like `/jdi-do` Step 3, and Step B
runs `/jdi-verify` Steps 4-5 (gates once, briefs, `dod_owner`) — the variables
below are the single-stack fast path.

```bash
DOER=$(grep -oE 'jdi-doer-[a-z0-9-]+' .jdi/specialists.md | head -1)
REVIEWER=$(grep -oE 'jdi-reviewer-[a-z0-9-]+' .jdi/reviewers.md | head -1)
[ -n "$DOER" ] || { echo "No doer registered in .jdi/specialists.md. /jdi-bootstrap."; exit 1; }
[ -n "$REVIEWER" ] || { echo "No reviewer registered in .jdi/reviewers.md. /jdi-bootstrap."; exit 1; }
```

### Step 4: Main loop

```
loop:
  # --- Step A: doer (fix mode: work list = `jdi-cli review blockers`) ---
  Agent(
    subagent_type=$DOER,
    description="Loop iter {iter} doer phase $PHASE_SLUG",
    prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, mode=ralph_loop"
  )

  # --- Step B: verify = /jdi-verify Steps 4-5 (gates run, briefs, reviewers) ---

  # --- Step C: record the iteration and get the decision ---
  DECISION=$(npx -y {{JDI_CLI}} loop record "$PHASE_SLUG")   # add --autonomous under /jdi-issue
```

Every iteration spawns FRESH agents — never SendMessage new work to the
previous ones. Each agent returns at most 10 lines; the decision comes from
`loop record`, not from reading REVIEW.md into this context.

`DECISION` is JSON; act on `status`:

| status | Action |
|---|---|
| `converged` | Update STATE.md (`phase_status: verified`, `next_step: /jdi-ship $PHASE_SLUG`); commit LOOP.md (`chore($PHASE_SLUG): loop converged at iter N`); exit 0 |
| `converged-with-warnings` | Same as `converged`; carry `prWarnings` (hollow-proof findings on rows that already spent their block, or found with no product change) to the ship/PR as `## Shipped with warnings`. When the review said BLOCKED (`reviewOverridden: true`), `loop record` already turned the verdict into APPROVED_WITH_WARNINGS and appended `## Loop override` (reason + findings) to REVIEW.md — commit REVIEW.md together with LOOP.md |
| `pending-manual` | STATE.md `phase_status: pending_manual_dod`, `next_step: /jdi-confirm-dod $PHASE_SLUG`; commit LOOP.md; exit 0 |
| `continue` | next iteration (`goto loop`) |
| `gate` | Human gate (oscillation or iteration cap) — AskUserQuestion: Continue (reset, `max_iter` more) → `npx -y {{JDI_CLI}} loop reset "$PHASE_SLUG" --reason "<why>"`; Abort → Step 6; Adjust plan → Step 7. A `killed` answer from `loop reset` → STATE.md `phase_status: blocked`, commit LOOP.md, exit 1 |

The decision rules live in the CLI (issue #62): a blocker tagged `[defect]`
(or untagged) always blocks, and so does a gate that failed on the current
commit (`gates run` report) or a BLOCKED review with no readable `Blockers`
list; one tagged `[hollow DoD N]` blocks once per DoD row; an iteration with
no open defect and no product change converges; a repeated finding hash in the
round is oscillation; reaching the reset cap kills the loop.

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
<!-- jdi:only claude -->
`.jdi/config.json` `models.doer` / `models.reviewer` other than `inherit` are
passed as the Agent `model` parameter.
<!-- jdi:end -->

**Copilot:** subagent spawning has no reliable completion signal. Run the loop
body inline instead: execute /jdi-do steps, then /jdi-verify steps, in this
same session, one iter at a time. Caps/oscillation/human gates unchanged.

**OpenCode/Antigravity:** use the runtime's native Task/spawn if available;
otherwise inline like Copilot.

**Orchestration mode:** the loop itself IS the standard path — it never adds
extra fan-out beyond doer/reviewer, so `orchestration.mode` (standard or
enhanced) requires no branching here. The DoD critic (`jdi-dod-critic`) runs
inside /jdi-verify Step 4.5 when it is on, with its lean cadence: a round where
no DoD proof changed spawns no critic. Inside the loop, verify is incremental
on multi-stack projects (`review plan`): a reviewer whose scope the fix did
not touch is carried, not re-spawned.
</runtime_notes>

<references>
- Ralph Wiggum technique (ghuntley.com/ralph)
- ASDLC Ralph Loop pattern (asdlc.io/patterns/ralph-loop)
- Convergence: P(C) = 1 - (1 - p_success)^n
</references>
