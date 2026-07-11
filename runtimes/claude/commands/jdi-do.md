---
name: jdi-do
description: Executes phase. Automatic routing to project's doer specialist. Wave-based parallel if phase has >=3 independent tasks. Accepts slug or position.
argument_hint: "<slug|position> [--sequential]"
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
      - "/jdi-do"
      - "execute phase"
---

<objective>
Executes all tasks of the given phase. Reads PLAN.md, groups into waves, dispatches doer specialist (jdi-doer-{slug}). Wave-based parallelism, sequential dispatch (one Agent per message with `run_in_background`).
</objective>

<arguments>
- `phase_id` (required): canonical slug, legacy slug, or integer position
- `--sequential` (optional): forces sequential execution even if waves allow parallel. Useful for debug.
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new."; exit 1; }
# STATE.md is an untracked advisory cache — absence is normal on a fresh clone
[ -f .jdi/STATE.md ] || echo "note: STATE.md absent — will be rewritten at the end of this command."

# Verify specialist exists
ls .jdi/agents/jdi-doer-*.md 2>/dev/null | head -1 || {
  echo "Doer specialist missing. Run /jdi-bootstrap."
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

# Verify PLAN.md exists
test -f "$PHASE_DIR/PLAN.md" || { echo "PLAN.md missing for phase $PHASE_SLUG. Run /jdi-plan $PHASE_SLUG."; exit 1; }

# Context budget warm-up
npx -y jdi-cli monitor .jdi/PROJECT.md .jdi/DECISIONS.md "$PHASE_DIR/PLAN.md" "$PHASE_DIR/CONTEXT.md" || true
```

### Step 3: Resolve doer specialist(s)

Read `.jdi/specialists.md`. Detect single vs multi-stack.

```bash
DOER_COUNT=$(grep -cE 'jdi-doer-[a-z0-9-]+' .jdi/specialists.md)
echo "Specialists registered: $DOER_COUNT"

if [ "$DOER_COUNT" -eq 0 ]; then
  echo "No doer registered. Run /jdi-bootstrap."
  exit 1
fi
```

**Single-stack** (`DOER_COUNT == 1`): take that doer, ignore task.specialist.
```bash
DOER=$(grep -oE 'jdi-doer-[a-z0-9-]+' .jdi/specialists.md | head -1)
```

**Multi-stack** (`DOER_COUNT > 1`): for each task in PLAN.md, read its `**Specialist:**` field (planner set this). Dispatch to that specialist. Tasks in same wave can spawn DIFFERENT specialists in parallel.

```bash
TASK_SPEC=$(awk -v t="$task_id" '/^#### '"$task_id"':/{flag=1} flag && /^\*\*Specialist:\*\*/{print $2; exit}' "$PHASE_DIR/PLAN.md")
```

If task lacks specialist field (legacy PLAN.md pre-1.12) → fallback to first doer registered.

### Step 4: Read PLAN.md, group waves

Parse PLAN.md, extract:
- List of pending tasks (`status: pending`)
- Each task's wave
- Files_modified

**Fix mode (zero pending tasks):** if no task is `pending` but
`$PHASE_DIR/REVIEW.md` exists with verdict BLOCKED (gates failed after all
tasks completed — e.g. coverage, lint), do NOT exit. Dispatch ONE doer in fix
mode and skip to Step 7:

```
Agent(
  subagent_type="$DOER",
  description="Fix blockers phase $PHASE_SLUG",
  prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, mode=fix_blockers.
          All tasks completed; REVIEW.md verdict is BLOCKED. Fix the items in
          REVIEW.md ## Blockers, run tests, commit atomically."
)
```

If no pending tasks and no BLOCKED review → "phase already executed", exit 0.

If `--sequential` or phase has <3 parallel tasks: use sequential execution (1 doer at a time).

Otherwise: wave-based parallel.

### Step 5: Intra-wave overlap check (safety)

For each wave:
- Get list of files_modified per task
- Check pair-by-pair: do 2 tasks share a file?
- If yes → override to sequential for that wave (warn user)

### Step 6: Execute waves

**For each wave in order:**

```
[wave {W}/{total}] starting, {N} tasks
```

**If parallel (>=2 tasks in wave + no overlap + not --sequential):**

Sequential dispatch — ONE `Agent()` per message with `run_in_background: true`. Each task resolves its OWN `subagent_type` from task.specialist (multi-stack):

```
TASK_SPECIALIST = <task.specialist field from PLAN.md> OR <single doer fallback>

Agent(
  subagent_type="${TASK_SPECIALIST}",
  description="Execute T-{X} phase $PHASE_SLUG",
  prompt="phase_slug=$PHASE_SLUG, phase_dir=$PHASE_DIR, task=T-{X}, mode=single_task",
  run_in_background: true
)
```

Within a wave, multi-stack projects may spawn DIFFERENT specialists in parallel (different file scopes, disjoint `files_modified`).

Wait for all to return before next wave.

**If sequential:** same prompt, no `run_in_background`, one at a time.

Doer reads PLAN.md/PROJECT.md/CONTEXT.md on its own — specialist convention.

### Step 7: After each wave

Read updated PLAN.md (doer updates status). Count:
- completed
- blocked
- pending

Blocked-task rule (every wave except the last is "critical" by construction —
later waves depend on it):
- Blocked task in a NON-FINAL wave → finish the current wave's remaining
  tasks, then STOP before dispatching the next wave (its dependencies cannot
  be satisfied). Mark phase `partial`, skip to Step 9.
- Blocked task in the FINAL wave → the other final-wave tasks still run;
  phase is marked `partial` at the end.

### Step 8: After all waves

Verify SUMMARY.md was created:
```bash
test -f "$PHASE_DIR/SUMMARY.md" || { echo "warn: SUMMARY missing"; }
```

### Step 9: Update STATE

```markdown
current_phase: $PHASE_POSITION
current_phase_slug: $PHASE_SLUG
phase_status: {executed|partial}
next_step: /jdi-verify $PHASE_SLUG
```

```bash
# STATE.md is gitignored on 0.3.0+ projects (untracked cache) — stage it only
# where legacy projects still track it, and skip the commit when nothing staged
git add .jdi/STATE.md 2>/dev/null || true
git diff --cached --quiet || git commit -m "chore(state): phase $PHASE_SLUG executed"
```

### Step 10: Confirm

```
Phase $PHASE_SLUG: {done}/{total} tasks ({blocked} blocked), {W} waves, {count} files.
SUMMARY: $PHASE_DIR/SUMMARY.md
Next: /jdi-verify $PHASE_SLUG
```

</process>

<gates>
- pre: PLAN.md exists + doer specialist registered in .jdi/specialists.md
- post: tasks executed (partial or total), SUMMARY.md created, STATE updated
</gates>

<errors>
- Doer missing → /jdi-bootstrap
- PLAN missing → /jdi-plan
- Doer fails on task → task stays `blocked`, continue with the rest (does not abort all)
- Entire wave blocked → abort phase, mark `partial`
</errors>

<runtime_notes>

**Claude Code:**
- Real sequential dispatch works via `run_in_background: true` in separate Agent calls
- Wait for completion via tool result notifications

**Copilot:**
- Subagent spawning does not return reliable signal
- Default = automatic `--sequential` in Copilot
- Loop foreach task, dispatch one at a time

**OpenCode/Antigravity:**
- Use runtime's native Task/spawn
- Parallelism if runtime supports
</runtime_notes>
