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
3. What do I run next? (exact command from STATE.md)

No agent invoked. No file mutation. Safe to run anytime.
</objective>

<arguments>
- `--stats` (optional): append outcome metrics derived from artifacts + git —
  measures what actually changed, not how much the agent ran.
</arguments>

<process>

### Step 1: Validation

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y jdi-cli render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).

```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new first."; exit 1; }
```

### Step 1.5: Regenerate STATE.md if absent (fresh clone)

STATE.md is an untracked per-clone advisory cache (gitignored since 0.3.0) —
a fresh clone legitimately has none. Regenerate it from artifacts: the current
phase is the first ROADMAP phase without SHIPPED.md.

```bash
if [ ! -f .jdi/STATE.md ]; then
  echo "STATE.md absent — regenerating advisory cache from phase artifacts."
  PROJECT_SLUG=$(awk '/^## Slug/{getline; while ($0 ~ /^[[:space:]]*$/) getline; print; exit}' .jdi/PROJECT.md)
  POS=1; SLUG=""; FOUND=false
  while RESOLVED="$(npx -y jdi-cli resolve-phase "$POS" 2>/dev/null)"; do
    eval "$RESOLVED"
    if [ ! -f "$JDI_PHASE_DIR/SHIPPED.md" ]; then SLUG="$JDI_PHASE_SLUG"; FOUND=true; break; fi
    POS=$((POS+1))
  done
  {
    echo "# ${PROJECT_SLUG} — State (regenerated advisory cache)"
    echo "project_slug: ${PROJECT_SLUG}"
    echo "schema_version: 2"
    if [ "$FOUND" = true ]; then
      echo "current_phase: $POS"
      echo "current_phase_slug: $SLUG"
      echo "next_step: (derived below)"
    else
      echo "current_phase: $((POS - 1))"
      echo "all_phases_complete: true"
      echo "next_step: project delivered"
    fi
  } > .jdi/STATE.md
fi
```

PowerShell mirrors with `ConvertFrom-Json` on the resolver output + `Set-Content`.

### Step 2: Read state

```bash
PROJECT_SLUG=$(grep -oE 'project_slug:\s*\S+' .jdi/STATE.md | awk '{print $2}')
SCHEMA=$(grep -oE 'schema_version:\s*[0-9]+' .jdi/STATE.md | grep -oE '[0-9]+' | head -1)
[ -z "$SCHEMA" ] && SCHEMA=1

# Current phase: prefer slug (v2), fall back to integer (v1)
CURRENT_SLUG=$(grep -E '^current_phase_slug:' .jdi/STATE.md | sed -E 's/^current_phase_slug:[[:space:]]*//' | head -1)
CURRENT_INT=$(grep -oE 'current_phase:\s*[0-9]+' .jdi/STATE.md | grep -oE '[0-9]+' | head -1)

CURRENT_ID="$CURRENT_SLUG"
[ -z "$CURRENT_ID" ] && CURRENT_ID="$CURRENT_INT"

PHASE_STATUS=$(grep -oE 'phase_status:\s*[a-z_-]+' .jdi/STATE.md | awk '{print $2}')
VERDICT=$(grep -oE 'phase_verdict:\s*[A-Z_]+' .jdi/STATE.md | awk '{print $2}')
NEXT_STEP=$(grep -E '^next_step:' .jdi/STATE.md | sed -E 's/^next_step:[[:space:]]*//')

# Derived, never read from a stored field: a legacy total_phases line can be
# STALE after a union merge — the heading count is always the truth.
TOTAL=$(grep -cE '^### Phase ' .jdi/ROADMAP.md)

# Resolve phase (handles slug OR int)
PHASE_DIR=""; PHASE_NAME=""; PHASE_POSITION=""
if [ -n "$CURRENT_ID" ]; then
  if RESOLVED="$(npx -y jdi-cli resolve-phase "$CURRENT_ID" 2>/dev/null)"; then
    eval "$RESOLVED"
    PHASE_DIR="$JDI_PHASE_DIR"
    PHASE_POSITION="$JDI_PHASE_POSITION"
    CURRENT_SLUG="$JDI_PHASE_SLUG"
  fi

  # Phase name from ROADMAP — by position
  if [ -n "$PHASE_POSITION" ]; then
    PHASE_NAME=$(awk -v n="$PHASE_POSITION" '
      /^### Phase / {
        line = $0
        sub(/^### Phase /, "", line)
        pos = line + 0
        if (pos == n) {
          sub(/^### Phase [0-9]+:[[:space:]]*/, "")
          print
          exit
        }
      }
    ' .jdi/ROADMAP.md)
  fi
fi
```

PowerShell mirrors via `Get-Content -Raw` + regex + the resolver `.ps1`.

### Step 2.5: Derive phase status from artifacts (source of truth)

STATE.md's `phase_status` is an advisory hint for this clone; the truth is
whatever artifacts exist in the phase folder. Derivation (first match wins):

```bash
DERIVED=pending
if [ -n "$PHASE_DIR" ] && [ -d "$PHASE_DIR" ]; then
  if   [ -f "$PHASE_DIR/SHIPPED.md" ]; then DERIVED=done
  elif [ -f "$PHASE_DIR/REVIEW.md"  ]; then DERIVED=verified
  elif [ -f "$PHASE_DIR/SUMMARY.md" ]; then DERIVED=executed
  elif [ -f "$PHASE_DIR/PLAN.md"    ]; then DERIVED=planned
  elif [ -f "$PHASE_DIR/CONTEXT.md" ]; then DERIVED=discussed
  fi
fi

# Project progress: shipped phases (works for every schema; legacy done
# phases without SHIPPED.md show via their ROADMAP Status line if present)
SHIPPED_COUNT=$(ls .jdi/phases/*/SHIPPED.md .jdi/archive/*/SHIPPED.md 2>/dev/null | wc -l | tr -d ' ')

# Side signals worth surfacing
TODO_COUNT=0
[ -f .jdi/todos.md ] && TODO_COUNT=$(grep -cE '^- ' .jdi/todos.md || true)
LOOP_STATE=""
[ -n "$PHASE_DIR" ] && [ -f "$PHASE_DIR/LOOP.md" ] && \
  LOOP_STATE=$(grep -m1 -oE '^status: [a-z]+' "$PHASE_DIR/LOOP.md" | awk '{print $2}')

# If STATE carries no usable next_step (regenerated cache), derive it from artifacts
if [ -z "$NEXT_STEP" ] || [ "$NEXT_STEP" = "(derived below)" ]; then
  case "$DERIVED" in
    done)      NEXT_STEP="/jdi-discuss (next phase)" ;;
    verified)
      RV=$(grep -oE '(Verdict|Veredicto):\*\* [A-Z_]+' "$PHASE_DIR/REVIEW.md" 2>/dev/null | awk '{print $2}')
      if echo "$RV" | grep -qx BLOCKED; then NEXT_STEP="fix blockers → /jdi-do $CURRENT_SLUG"
      elif echo "$RV" | grep -qx APPROVED_PENDING_MANUAL; then NEXT_STEP="/jdi-confirm-dod $CURRENT_SLUG"
      else NEXT_STEP="/jdi-ship $CURRENT_SLUG"; fi ;;
    executed)  NEXT_STEP="/jdi-verify $CURRENT_SLUG" ;;
    planned)   NEXT_STEP="/jdi-do $CURRENT_SLUG" ;;
    discussed) NEXT_STEP="/jdi-plan $CURRENT_SLUG" ;;
    pending)   NEXT_STEP="/jdi-discuss $CURRENT_SLUG" ;;
  esac
fi
```

### Step 3: Detect last artifact in current phase

Priority order (most recent stage first): `SHIPPED.md` → `REVIEW.md` → `SUMMARY.md` → `PLAN.md` → `CONTEXT.md`.

```bash
LAST_ARTIFACT=""
LAST_ARTIFACT_PATH=""
if [ -n "$PHASE_DIR" ] && [ -d "$PHASE_DIR" ]; then
  for f in SHIPPED.md REVIEW.md SUMMARY.md PLAN.md CONTEXT.md; do
    if [ -f "$PHASE_DIR/$f" ]; then
      LAST_ARTIFACT="$f"
      LAST_ARTIFACT_PATH="$PHASE_DIR/$f"
      break
    fi
  done
fi
```

### Step 4: Pull one-line summary from the last artifact

Extract a 1-line headline so the user sees what was last produced without opening the file.

- `SHIPPED.md`: pull the `shipped_at:` + `verdict:` lines.
- `REVIEW.md`: pull the `**Verdict:**` line.
- `SUMMARY.md`: pull `**Status:**` + `**Tasks:**` line.
- `PLAN.md`: pull `Total tasks:` and `Waves:` from the Execution section.
- `CONTEXT.md`: pull the `## Goal` line.

```bash
HEADLINE=""
if [ -n "$LAST_ARTIFACT_PATH" ]; then
  case "$LAST_ARTIFACT" in
    SHIPPED.md)
      HEADLINE=$(head -2 "$LAST_ARTIFACT_PATH" | tr '\n' ' ')
      ;;
    REVIEW.md)
      HEADLINE=$(grep -m1 -E '^\*\*(Veredicto|Verdict):\*\*' "$LAST_ARTIFACT_PATH" | sed -E 's/\*\*//g')
      ;;
    SUMMARY.md)
      HEADLINE=$(grep -m1 -E '^\*\*(Status|Tasks):\*\*' "$LAST_ARTIFACT_PATH" | sed -E 's/\*\*//g')
      ;;
    PLAN.md)
      TASKS=$(grep -oE 'Total tasks:\s*[0-9]+' "$LAST_ARTIFACT_PATH" | head -1)
      WAVES=$(grep -oE 'Waves:\s*[0-9]+' "$LAST_ARTIFACT_PATH" | head -1)
      HEADLINE="$TASKS, $WAVES"
      ;;
    CONTEXT.md)
      HEADLINE=$(awk '/^## Goal/{getline; print; exit}' "$LAST_ARTIFACT_PATH")
      ;;
  esac
fi
```

### Step 5: Last commit (project history)

```bash
LAST_COMMIT=$(git log -1 --format='%h  %s' 2>/dev/null || echo "(no commits yet)")
COMMITS_TODAY=$(git log --since=midnight --format='%h' 2>/dev/null | wc -l | tr -d ' ')
```

### Step 6: Print

```
══════════════════════════════════════════════════
  JDI status
══════════════════════════════════════════════════
  Project:        {project_slug}
  Schema:         v{SCHEMA}
  Phase:          {position}/{total} — {phase_name} (slug: {slug})
  Phase status:   {DERIVED}   (STATE hint: {phase_status or "—"})
  Verdict:        {verdict or "—"}
  Shipped:        {SHIPPED_COUNT}/{total} phases

  Last artifact:  {last_artifact}
                  {path}
                  {headline}

  {if LOOP_STATE:}Ralph loop:     {LOOP_STATE}
  {if TODO_COUNT > 0:}Todos backlog:  {TODO_COUNT} item(s) in .jdi/todos.md (captured creep — review at /jdi-discuss)

  Last commit:    {hash}  {subject}
  Commits today:  {commits_today}

══════════════════════════════════════════════════
  Next step:      {next_step}
══════════════════════════════════════════════════
```

**Empty-state messages:**

- `{verdict}` empty → `—`.
- `{last_artifact}` empty → `(none — phase has not started)`.
- `{next_step}` empty → `(STATE.md missing next_step — possibly corrupted state)`.
- v1 project without slug → use position only (`Phase: 3/8 — auth flow`).

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
- `--json` → emit machine-readable JSON for pipelines.

</process>

<gates>
- pre: `.jdi/` exists (STATE.md optional — regenerated from artifacts when absent)
- post: status snapshot printed. Only possible write: regenerated STATE.md (untracked cache). No commit. No agent spawned.
</gates>

<errors>
- `.jdi/` missing → "Run /jdi-new first"
- STATE.md missing → regenerate advisory cache from artifacts (Step 1.5) — not an error
- ROADMAP.md missing → warn and continue (some fields empty)
- Phase id unresolvable → print "(phase id stale)" but do not fail
- Not a git repo → commit fields print "(no commits yet)" — does not fail
</errors>

<runtime_notes>

**Claude Code:**
- Pure Bash + Grep + Read + resolver lib. No Agent invocation.

**Copilot:**
- Same — terminal-driven.

**OpenCode/Antigravity:**
- Same — pure shell. Antigravity triggers also fire on natural-language phrases.

</runtime_notes>
