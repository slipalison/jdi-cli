---
name: jdi-next
description: The one command to remember. Derives where the current phase is from its artifacts and runs the correct next step — discuss, plan, do, verify, confirm-dod, ship, or fix after a BLOCKED review. Zero arguments needed. --loop (or orchestration.next_execution "loop" in config.json) makes the execute/verify states run the bounded ralph loop instead of single steps.
argument_hint: "[slug|position] [--loop]"
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
      - "/jdi-next"
      - "what's next, just do it"
      - "continue the jdi flow"
      - "jdi next step"
---

<objective>
Single entry point for the whole loop. Instead of memorizing the command
sequence (discuss → plan → do → verify → [confirm-dod] → ship), run `/jdi-next`
repeatedly: it derives the phase status from artifacts (never from STATE.md)
and EXECUTES the right next command. Complexity lives here, not in the user's
head.
</objective>

<arguments>
- `phase_id` (optional): canonical slug, legacy slug, or integer position.
  Omitted → the current phase is derived: first ROADMAP phase without SHIPPED.md.
- `--loop` (optional): on the execute/verify states (`planned`, `executed`,
  `verified+BLOCKED`) route to `/jdi-loop` (bounded ralph: do ↔ verify with
  caps + audit) instead of a single `do`/`verify` step. Same effect
  per-project via `config.json` → `orchestration.next_execution: "loop"`.
  Default is `step`: a next that silently starts up to 15 iterations would
  betray its one-predictable-step contract, and ralph presumes a trustworthy
  test suite — making loop primary is a per-project decision.
</arguments>

<process>

### Step 1: Pre-flight routing (project-level gaps first)

```bash
if [ ! -d .jdi/ ]; then
  echo "Not a JDI project yet. Run: /jdi-new \"<short description>\" (or /jdi-adopt for an existing repo)."
  exit 0   # cannot auto-run: new/adopt need your description/confirmation
fi

if ! ls .jdi/agents/jdi-doer-*.md >/dev/null 2>&1; then
  TARGET=jdi-bootstrap   # specialists missing → bootstrap is the next step
fi
```

### Step 2: Resolve the target phase

```bash
if [ -n "${1:-}" ]; then
  RESOLVED="$(npx -y jdi-cli resolve-phase "$1")" || { echo "Phase '$1' not found."; exit 1; }
  eval "$RESOLVED"
else
  # current phase = first ROADMAP phase without SHIPPED.md
  POS=1; FOUND=false
  while RESOLVED="$(npx -y jdi-cli resolve-phase "$POS" 2>/dev/null)"; do
    eval "$RESOLVED"
    [ -f "$JDI_PHASE_DIR/SHIPPED.md" ] || { FOUND=true; break; }
    POS=$((POS+1))
  done
  [ "$FOUND" = true ] || { echo "All phases shipped. Project delivered. (Add more: /jdi-add-phase)"; exit 0; }
fi
PHASE_SLUG="$JDI_PHASE_SLUG"; PHASE_DIR="$JDI_PHASE_DIR"
```

### Step 3: Derive status → pick the target command

Artifact ladder (first match wins), then verdict routing:

```bash
# Loop mode: --loop flag OR config.json orchestration.next_execution == "loop"
LOOP_MODE=false
for a in "$@"; do [ "$a" = "--loop" ] && LOOP_MODE=true; done
if [ "$LOOP_MODE" = false ] && [ -f .jdi/config.json ] && command -v jq >/dev/null 2>&1; then
  [ "$(jq -r '.orchestration.next_execution // "step"' .jdi/config.json)" = "loop" ] && LOOP_MODE=true
fi

if [ -z "${TARGET:-}" ]; then
  if   [ -f "$PHASE_DIR/SHIPPED.md" ]; then TARGET=""; echo "Phase $PHASE_SLUG already shipped."; exit 0
  elif [ -f "$PHASE_DIR/REVIEW.md"  ]; then
    V=$(grep -oE '(Verdict|Veredicto):\*\* (APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED)' "$PHASE_DIR/REVIEW.md" | awk '{print $2}')
    if   echo "$V" | grep -qx BLOCKED;                 then TARGET=jdi-do        # fix mode
    elif echo "$V" | grep -qx APPROVED_PENDING_MANUAL; then TARGET=jdi-confirm-dod
    elif [ -n "$V" ];                                  then TARGET=jdi-ship
    else echo "REVIEW.md has no verdict — re-run /jdi-verify $PHASE_SLUG."; TARGET=jdi-verify; fi
  elif [ -f "$PHASE_DIR/SUMMARY.md" ]; then TARGET=jdi-verify
  elif [ -f "$PHASE_DIR/PLAN.md"    ]; then TARGET=jdi-do
  elif [ -f "$PHASE_DIR/CONTEXT.md" ]; then TARGET=jdi-plan
  else                                      TARGET=jdi-discuss
  fi

  # Loop mode upgrades the execute/verify states to the bounded ralph loop
  # (do ↔ verify with caps + LOOP.md audit). Other states are untouched.
  if [ "$LOOP_MODE" = true ]; then
    case "$TARGET" in jdi-do|jdi-verify) TARGET=jdi-loop ;; esac
  fi
fi

echo "Next step for phase $PHASE_SLUG: /$TARGET $PHASE_SLUG — executing now."
```

### Step 4: Execute the target command's process

Read the INSTALLED command file for `$TARGET` and follow its `<process>`
faithfully — gates, prompts, commits, everything. Never bypass its
validations; `/jdi-next` only routes, the target command still enforces its
own gates.

Installed command file per runtime (first path that exists):

| Runtime | Path |
|---|---|
| Claude Code | `.claude/commands/{TARGET}.md` (or `~/.claude/commands/{TARGET}.md`) |
| Copilot | `.github/prompts/{TARGET}.prompt.md` |
| OpenCode | `.opencode/commands/{TARGET}.md` |
| Antigravity | `skills/{TARGET}/SKILL.md` (or user-scope skills dir) |

Pass `$PHASE_SLUG` as the command's `phase_id` argument.

If the file is not found in any location: print
`Run: /{TARGET} $PHASE_SLUG` and exit 0 (manual fallback — never guess the
process from memory).

### Step 5: After the target command finishes

Print the follow-up hint:

```
Done. Run /jdi-next again for the next step.
```

(One step per invocation — predictable and reviewable. For unattended
iteration use `/jdi-loop $PHASE_SLUG`, which is the bounded automation path.)

</process>

<gates>
- pre: `.jdi/` exists (everything else is routed, not required)
- post: exactly ONE target command executed (with its own gates) or a clear instruction printed
</gates>

<errors>
- `.jdi/` missing → point to /jdi-new + /jdi-adopt (no auto-run: they need user input)
- Phase id not resolvable → exit with hint
- REVIEW.md without verdict → route to /jdi-verify (regenerates it)
- Installed command file not found → print the command for manual run (never improvise its process)
</errors>

<runtime_notes>

**Claude Code:**
- Read `.claude/commands/{TARGET}.md`, then execute its `<process>` inline (Agent spawns included).

**Copilot:**
- Read `.github/prompts/{TARGET}.prompt.md`; sub-agent steps degrade to sequential as usual.

**OpenCode/Antigravity:**
- Same pattern via `.opencode/commands/` or the skill folder; Antigravity triggers also fire on "continue the jdi flow".

</runtime_notes>
