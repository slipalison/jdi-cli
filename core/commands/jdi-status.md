---
name: jdi-status
description: Prints a compact summary of where the project is — current phase, what the last action did, and the exact next command to run. --stats adds outcome metrics derived from artifacts (first-pass rate, loop iterations, lead time). Read-only. No agent invoked.
argument_hint: "[--stats]"
runtime_intent:
  invokes_agent: none
runtime_overrides:
  claude:
    allowed-tools: [Read, Bash, Grep, Glob]
  copilot:
    tools: [read, grep, glob, terminal]
  opencode:
    subtask: false
  antigravity:
    triggers:
      - "/jdi-status"
      - "where did we stop"
      - "what's next"
      - "resume jdi"
      - "jdi summary"
---

<objective>
Pure read-only status snapshot for fast session resumption. Answers three questions in one screen:
1. Where am I? (project, current phase, status, verdict)
2. What was the last thing done? (last artifact + last commit)
3. What do I run next? (exact command, derived from the artifacts)

No agent invoked. No file mutation. Safe to run anytime.
</objective>

<arguments>
- `--stats` (optional): append outcome metrics derived from artifacts + git —
  measures what actually changed, not how much the agent ran.
</arguments>

<process>

### Steps 1-6: One call, print it verbatim

```bash
npx -y {{JDI_CLI}} next --status
```

It derives everything from the artifacts (never from STATE.md, which is an
advisory per-clone cache): project slug, current phase (first roadmap phase
without SHIPPED.md) with position/total and name, derived status
(`pending → discussed → planned → executed → verified → done`), verdict, shipped
count, last artifact with a one-line headline, ralph-loop state, todo backlog,
last commit and the exact next command (same ladder as `/jdi-next`). It reads
the per-entry dirs directly — no render, no file written.

Print its output as is. Do not open the artifacts to "confirm" it: the
headline is what this command is for. `--json` gives the same fields for
tooling.

### Step 7: `--stats` — outcome metrics (only when the flag is passed)

Activity is not outcome: sessions run and tokens burned say nothing about
whether delivery improved. Everything below is DERIVED read-only from
artifacts + git history — no telemetry, no new files.

Per shipped phase (walk `phases/*/SHIPPED.md` + `archive/*/SHIPPED.md`):

```bash
for f in .jdi/phases/*/SHIPPED.md .jdi/archive/*/SHIPPED.md; do
  [ -f "$f" ] || continue
  d=$(dirname "$f"); slug=$(basename "$d")
  VERDICT=$(grep -m1 '^verdict:' "$f" | awk '{print $2}')
  SHIPPED_AT=$(grep -m1 '^shipped_at:' "$f" | awk '{print $2}')

  # verify rounds = commits touching this phase's REVIEW.md (each verify commits it)
  ROUNDS=$(git log --oneline -- "$d/REVIEW.md" 2>/dev/null | wc -l | tr -d ' ')

  # ralph iterations, if the loop ran (count history lines across all rounds)
  ITERS=0
  [ -f "$d/LOOP.md" ] && ITERS=$(grep -cE '^- iter [0-9]+:' "$d/LOOP.md" || true)

  # blocked tasks recorded by the doer
  BLOCKED=$(grep -m1 -oE '[0-9]+ blocked' "$d/SUMMARY.md" 2>/dev/null | awk '{print $1}')

  # lead time: first commit touching the phase folder → shipped_at
  STARTED=$(git log --reverse --format=%cI -- "$d" 2>/dev/null | head -1)

  # learnings distilled
  LEARN=$(grep -cE '^- ' <(sed -n '/^## Learnings/,$p' "$f") 2>/dev/null || echo 0)

  echo "$slug|$VERDICT|rounds=$ROUNDS|iters=$ITERS|blocked=${BLOCKED:-0}|$STARTED→$SHIPPED_AT|learnings=$LEARN"
done
```

Aggregate and print:

```
──────────────────────────────────────────────────
  Outcomes ({N} shipped phases)
──────────────────────────────────────────────────
  First-pass rate:   {X}/{N} phases approved on verify round 1
  Verify rounds:     avg {X.X} per phase (1.0 = ideal)
  Ralph iterations:  {total} across {K} phases that used /jdi-loop
  Blocked tasks:     {total} (doer hit 3-attempt cap or out-of-scope)
  Lead time:         median {D} days discuss → ship
  Learnings:         {total} distilled, {K} phases carried lessons forward
──────────────────────────────────────────────────
```

Interpretation guide (print only when a signal fires):
- First-pass rate falling across recent phases → plans/DoD too loose — tighten `/jdi-discuss` decisions.
- Same learning appearing in 3+ SHIPPED.md files → recurring failure not being absorbed; consider promoting it into the doer specialist's conventions manually.
- High blocked count with low iters → tasks under-specified (missing acceptance criteria), not hard.

Reserved for later, do not implement now:
- `--verbose` → dump full last artifact body (truncated to first 40 lines).

</process>

<gates>
- pre: `.jdi/` exists (STATE.md not needed — everything is derived from artifacts)
- post: status snapshot printed. No file written. No commit. No agent spawned.
</gates>

<errors>
- `.jdi/` missing → "Run /jdi-new first"
- ROADMAP.md missing → warn and continue (some fields empty)
- Phase id unresolvable → print "(phase id stale)" but do not fail
- Not a git repo → commit fields print "(no commits yet)" — does not fail
</errors>

<runtime_notes>

**Claude Code:**
- One Bash call (`next --status`); `--stats` adds the Step 7 loop. No Agent invocation.

**Copilot:**
- Same — terminal-driven.

**OpenCode/Antigravity:**
- Same — pure shell. Antigravity triggers also fire on natural-language phrases.

</runtime_notes>
