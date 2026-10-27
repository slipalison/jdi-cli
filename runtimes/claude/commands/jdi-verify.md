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
- `--full` (optional): run every reviewer even when an untouched one could be carried (multi-stack incremental verify), and every gate even when a PASS on the same inputs could be reused (`gates run --fresh`). Sets `FULL=1`.
</arguments>

<process>

### Step 1: Validation

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y jdi-cli@0.22.0 render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).
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
npx -y jdi-cli@0.22.0 sync-specialists --check --quiet || npx -y jdi-cli@0.22.0 sync-specialists --quiet
```

### Step 2: Resolve phase

```bash
RESOLVED="$(npx -y jdi-cli@0.22.0 resolve-phase "$1")" || { echo "Phase '$1' not found."; exit 1; }
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
RPLAN=$(npx -y jdi-cli@0.22.0 review plan "$PHASE_SLUG" --reviewers "$REVIEWERS" ${FULL:+--full})   # JSON: mode, run, carry, reasons
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
so), coverage, lint and the dependency audit per stack, then the automatic DoD
rows ONCE for the whole phase. The stacks first: a `Verify (test):` row is
proven by the test report they leave. Long suites run here, in this shell, not
inside a large reviewer context waiting on them; with
`economy.parallel_gates: true` the stacks run at the same time.

```bash
if [ -d .jdi/stacks ]; then
  GRUN_RC=0
  STACKS=$(echo $RUN | tr ' ' ',')                             # carried reviewers: no gates
  if [ -n "$STACKS" ]; then npx -y jdi-cli@0.22.0 gates run "$PHASE_SLUG" --stack "$STACKS" ${FULL:+--fresh}; GRUN_RC=$?; fi
  npx -y jdi-cli@0.22.0 gates run "$PHASE_SLUG" --only dod ${FULL:+--fresh}   # DoD once (E2E/real-login rows: EVIDENCE, never executed)
  npx -y jdi-cli@0.22.0 gates show "$PHASE_SLUG" --failures --all > .jdi/cache/gate-failures.txt; GATES_RC=$?
fi
```

`GRUN_RC` other than 0, 1 or 5 (no stack could be resolved, a crash): STOP —
the gates did not run, and an empty failures list is not a pass.
`GATES_RC` = 5 (status `ENV`: a stack's `requires` — env var, command, free
disk, its `check` — is not met, a `Verify (test):` row has no report to
read, or a command failed for the machine, not the code: the command was not
found, or the disk was full): STOP and show `.jdi/cache/gate-failures.txt`. The environment is not a
code defect: no doer, no reviewer, no loop round until it is fixed (under
`/jdi-loop`: the loop pauses, nothing is recorded).

`EVIDENCE` rows are never run by the gates: the `dod` report carries the
freshness of their recorded runs (`evidence: {iteration, ship}`,
`npx -y jdi-cli@0.22.0 evidence status "$PHASE_SLUG"`). A row whose `iteration`
is `stale` or `missing`: run its `Iteration:` command (the full `Verify
(evidence):` when it has none) ONCE, here in the shell — never in a retry
loop: real logins lock accounts — then
`npx -y jdi-cli@0.22.0 evidence record "$PHASE_SLUG" --row N --scope iteration --artifact <report>`.
`fresh` = the last run still holds; do not run it again.

Every gate command runs under a watchdog: on its `timeout_min`, or after the
stack's `idle_timeout_s` with no output (when set), the WHOLE process tree is
killed — no test runner left holding a lock after the gate "ended" — and the
gate FAILs with that reason first in its excerpt (a deadlock is a defect a
doer can look at).


A gate that PASSed on exactly the same inputs (product files, the files a DoD
row names, the command, the stack config) is not run again: its line says
`reused <key>: passed on <commit> at <time>` (`economy.gate_cache`; a FAIL is
never reused, nor the `audit`; `--full` runs everything).

**4a'. Green gates before judgment.** `GATES_RC` = 1 (a gate or an automatic
DoD row failed): a failing test, lint or coverage needs no reviewer to say so —
spawning reviewers and the critic now buys a BLOCKED verdict and a whole loop
round. ONE fix pass first: a FRESH doer per stack with failures (the doer
paired with that reviewer), each with its own list —
`npx -y jdi-cli@0.22.0 gates show "$PHASE_SLUG" --failures --stack <stack> > .jdi/cache/gate-failures-<stack>.txt`
and `mode=fix_wave failures=.jdi/cache/gate-failures-<stack>.txt` (routed
with `route ... --role doer --attempt 2`: a measured failure — on Copilot
and OpenCode with `--runtime <rt> --agent <that doer>`, spawning its
`agent`); the DoD
failures (`gates show "$PHASE_SLUG" --failures`, the `dod` report) go to the
first stack's doer. A fix that committed changes what `review plan` decided
(a carried reviewer's scope may now have changed): run Step 4 again from
`review plan` (what passed is reused). Still red: no reviewer —

```bash
npx -y jdi-cli@0.22.0 review from-gates "$PHASE_SLUG"   # REVIEW.md BLOCKED, one [defect] per failure, stamped
```

— and go to Step 5 (the loop's next round fixes them; `/jdi-verify` alone
reports BLOCKED).

**4b. One brief per reviewer** (scope + changed files, gate results, tasks,
DoD, decisions for Gate 6, known errors):

```bash
BRIEF_R=$(npx -y jdi-cli@0.22.0 brief "$PHASE_SLUG" --role reviewer --stack "$REVIEWER" --runtime claude | cut -d' ' -f1)
```

**4c. DoD proof checks — before the spawn.** Gate 8 maps `exit 0 → PASS` for
automatic DoD rows. A command can exit 0 without proving its criterion (a grep
on text that already exists, a test that asserts nothing). These checks can
only make the verdict **stricter**.

*Bait (mechanical, any runtime).* Rows that carry a `Bait:` (a mutation that
breaks the criterion) are checked in a throwaway worktree at HEAD (one per
run, its build output kept between rows): the Verify must pass, then fail once
the Bait is applied. A CAUGHT row is not re-run until its proof changes.

```bash
npx -y jdi-cli@0.22.0 dod bait "$PHASE_SLUG"      # no-op when no row has a Bait
```

*Critic (judgment).* Runs when this runtime can spawn sub-agents AND the
critic is on: `orchestration.mode == "enhanced"`, or the invoking orchestrator
passed `critic=on` (`/jdi-issue`). `economy.critic: "off"` turns it off; a
LITE phase (`jdi-cli size`) skips it unless `critic=on`. Lean cadence: only
rows never examined, rows whose proof changed and rows found hollow last time
— not rows already sound, bait-checked, failing (a defect, not a hollow pass)
or whose hollow-proof block the loop already spent (such a row is looked at
once more after the block — it may have been fixed — and can no longer block).
(`economy.critic: "every_verify"` re-examines every row each time.)

```bash
CRIT=$(npx -y jdi-cli@0.22.0 critic plan "$PHASE_SLUG" --runtime claude)   # JSON: rows, brief, skip
```

**4d. Spawn — the reviewers and the critic together.** The gates already ran
(4a), so the agents only read and judge: nothing they do can collide. Right
before the spawn, record what the tree looks like:

```bash
npx -y jdi-cli@0.22.0 review baseline "$PHASE_SLUG"   # HEAD + the hash of every changed file
```

Then spawn them in ONE message, all at once, and wait for every one:

- each reviewer of `$RUN`: `prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, mode=verify, reviewer_segment=$REVIEWER, dod_owner=<true for the first>, brief=$BRIEF_R"`,
  plus `segment_file=<RPLAN.segments[$REVIEWER]>` when `RPLAN.parallel` is true;
- the critic, when `CRIT.rows` is non-empty: `subagent_type="jdi-dod-critic"`,
  `prompt="phase_slug=$PHASE_SLUG, brief=<brief from CRIT>"`.

```
Agent(subagent_type="$REVIEWER_1", description="Verify phase $PHASE_SLUG ($REVIEWER_1)", prompt="...")
Agent(subagent_type="$REVIEWER_2", description="Verify phase $PHASE_SLUG ($REVIEWER_2)", prompt="...")   # multi-stack
Agent(subagent_type="jdi-dod-critic", description="DoD critic $PHASE_SLUG", prompt="...")              # critic on
```

The FIRST reviewer owns the DoD Checklist (`dod_owner=true`); the others
reference it — the DoD is evaluated once, not once per reviewer. Several
reviewers spawn together ONLY when `RPLAN.parallel` is true (every one writes
its own segment file); otherwise the reviewers go one at a time, each one
waiting for the previous (an older specialist appends to REVIEW.md itself) —
the critic still goes with the first of them. A runtime that cannot spawn
in parallel runs them in sequence; the order does not change the result.

Model and effort: `npx -y jdi-cli@0.22.0 route "$PHASE_SLUG" --role reviewer --json`
(and `--role critic` for the critic) → its `model` and `effort` as the Agent
parameters (a `null` one left out). Reviewers and the critic never go below
their `floors` tier (cheap models miss real defects); the reviewers of a
phase that touches `sizing.sensitive_globs` get the strong one. Never re-dispatch work to a
reviewer that already returned (SendMessage): spawn a fresh one.

Each reviewer scopes its gates to its `file_glob` (from frontmatter
`scope.file_glob`); coverage threshold enforced only on files matching the
glob. Reviewers are read-only (they write only their segment). Each returns a
short verdict line (return contract): do not open REVIEW.md to repeat it —
Step 5 reads the verdicts mechanically. The dispatch prompt is the line above,
nothing more: no reading lists, no plan text.

### Step 4.5: Fold the results in

Assemble REVIEW.md (segments in registry order, carried segments back) and
stamp the verified commit (`<!-- jdi:verified head=… -->` — `/jdi-ship`
refuses a review older than the code); then the critic's findings — always,
even when the critic did not run (a Bait that survived is an objective hollow
proof):

```bash
npx -y jdi-cli@0.22.0 review merge "$PHASE_SLUG"
npx -y jdi-cli@0.22.0 critic apply "$PHASE_SLUG"
```

`merge` also checks that the reviewers stayed read-only (against the
`review baseline` of 4d): a commit of product files made during the review
(`.jdi/` does not count) → a `## Read-only check` segment, BLOCKED
`[defect]`; files changed but not committed → a warning naming them. Agents that judge must not edit what they judge.

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
VERDICT=$(npx -y jdi-cli@0.22.0 review verdict "$PHASE_SLUG") || { echo "Reviewer wrote no verdict line — REVIEW.md malformed. Aborting."; exit 1; }
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
# loop.record_commits "at_ship": the process record stays out of the product
# history until the ship commit (`reviews/round-N.md` keeps every round).
if [ "$(node -p "(require('./.jdi/config.json').loop||{}).record_commits||''" 2>/dev/null)" != "at_ship" ]; then
  git add "$PHASE_DIR/REVIEW.md"; git add .jdi/STATE.md 2>/dev/null || true
  git commit -m "docs($PHASE_SLUG): verify phase ($VERDICT)"
fi
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
