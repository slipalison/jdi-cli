---
name: jdi-do
description: Executes phase. Automatic routing to project's doer specialist. Wave-based parallel if phase has >=3 independent tasks.
argument_hint: "<phase_number> [--sequential]"
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
      - "/jdi-do"
      - "execute phase {N}"
---

<objective>
Executes all tasks of the given phase. Reads PLAN.md, groups into waves, dispatches doer specialist (jdi-doer-{slug}). Wave-based parallelism, sequential dispatch (one Agent per message with `run_in_background`).
</objective>

<arguments>
- `phase_number` (required)
- `--sequential` (optional): forces sequential execution even if waves allow parallel. Useful for debug.
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new."; exit 1; }
test -f .jdi/STATE.md || { echo "STATE.md missing."; exit 1; }

# Verify specialist exists
ls .jdi/agents/jdi-doer-*.md 2>/dev/null | head -1 || {
  echo "Doer specialist missing. Run /jdi-bootstrap."
  exit 1
}

# Verify PLAN.md exists for phase
ls .jdi/phases/{NN}*/PLAN.md 2>/dev/null || {
  echo "PLAN.md missing for phase {N}. Run /jdi-plan {N}."
  exit 1
}

# Context budget warm-up (does not block)
JDI_LIB="$(dirname "$(command -v jdi 2>/dev/null || echo /usr/local/bin/jdi)")/../lib"
if [ -f "$JDI_LIB/jdi-monitor.sh" ]; then
  bash "$JDI_LIB/jdi-monitor.sh" .jdi/PROJECT.md .jdi/DECISIONS.md .jdi/phases/{NN}*/PLAN.md .jdi/phases/{NN}*/CONTEXT.md || true
fi
# Windows: pwsh -File "$JDI_LIB/jdi-monitor.ps1" -Paths @(...)
```

### Step 2: Resolve doer specialist(s)

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
# Per task, extract specialist from PLAN.md
TASK_SPEC=$(awk -v t="$task_id" '/^#### '"$task_id"':/{flag=1} flag && /^\*\*Specialist:\*\*/{print $2; exit}' .jdi/phases/{NN}*/PLAN.md)
```

If task lacks specialist field (legacy PLAN.md pre-1.12) → fallback to first doer registered.

### Step 3: Read PLAN.md, group waves

Parse PLAN.md, extract:
- List of pending tasks (`status: pending`)
- Each task's wave
- Files_modified

If `--sequential` or phase has <3 parallel tasks: use sequential execution (1 doer at a time).

Otherwise: wave-based parallel.

### Step 4: Intra-wave overlap check (safety)

For each wave:
- Get list of files_modified per task
- Check pair-by-pair: do 2 tasks share a file?
- If yes -> override to sequential for that wave (warn user)

### Step 5: Execute waves

**For each wave in order:**

```
[wave {W}/{total}] starting, {N} tasks
```

**If parallel (>=2 tasks in wave + no overlap + not --sequential):**

Sequential dispatch — ONE `Agent()` per message with `run_in_background: true`. Each task resolves its OWN `subagent_type` from task.specialist (multi-stack):

```
# For each task in wave, resolve specialist:
TASK_SPECIALIST = <task.specialist field from PLAN.md> OR <single doer fallback>

Agent(
  subagent_type="${TASK_SPECIALIST}",   # may differ per task in multi-stack
  description="Execute T-{X}.{Y} phase {N}",
  prompt="phase={N}, task=T-{X}.{Y}, mode=single_task",
  run_in_background: true
)
```

Within a wave, multi-stack projects may spawn DIFFERENT specialists in parallel (e.g. `jdi-doer-myapp-backend` and `jdi-doer-myapp-frontend` simultaneously — different file scopes, disjoint `files_modified`).

Wait for all to return before next wave.

**If sequential:** same prompt, no `run_in_background`, one at a time.

Doer reads PLAN.md/PROJECT.md/CONTEXT.md on its own — specialist convention.

### Step 6: After each wave

Read updated PLAN.md (doer updates status). Count:
- completed
- blocked
- pending

If any task `blocked` in critical wave -> stop execution, mark phase `partial`, skip to Step 8.

### Step 7: After all waves

Verify SUMMARY.md was created:
```bash
test -f .jdi/phases/{NN}*/SUMMARY.md || { echo "warn: SUMMARY missing"; }
```

### Step 8: Update STATE

```markdown
current_phase: {N}
phase_status: {executed|partial}
next_step: /jdi-verify {N}
```

```bash
git add .jdi/STATE.md
git commit -m "chore(state): phase {N} executed"
```

### Step 9: Confirm

```
Phase {N}: {done}/{total} tasks ({blocked} blocked), {W} waves, {count} files.
SUMMARY: .jdi/phases/{NN-slug}/SUMMARY.md
Next: /jdi-verify {N}
```

</process>

<gates>
- pre: PLAN.md exists + doer specialist registered in .jdi/specialists.md
- post: tasks executed (partial or total), SUMMARY.md created, STATE updated
</gates>

<errors>
- Doer missing -> /jdi-bootstrap
- PLAN missing -> /jdi-plan
- Doer fails on task -> task stays `blocked`, continue with the rest (does not abort all)
- Entire wave blocked -> abort phase, mark `partial`
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
