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

### Steps 1-3: Derive the next command (one deterministic call)

The whole routing — project gaps (no `.jdi/` → /jdi-new or /jdi-adopt; no
specialists → /jdi-bootstrap), phase resolution (current = first roadmap phase
without SHIPPED.md), the artifact ladder and the verdict routing — is one CLI
call. It reads the per-entry dirs directly (no render needed) and never
STATE.md.

```bash
NEXT_JSON=$(npx -y jdi-cli@0.18.0 next ${PHASE_ID:+"$PHASE_ID"} ${LOOP_FLAG:+--loop} --json) || exit $?
```

`PHASE_ID` = the `phase_id` argument (omit for the current phase);
`LOOP_FLAG` set when `--loop` was passed (the CLI also honors
`orchestration.next_execution: "loop"`). The JSON:

| field | meaning |
|---|---|
| `next` | the command to run, e.g. `/jdi-plan user-auth` — `null` when nothing can run |
| `reason` | why (`specialists missing`, `REVIEW.md has no verdict`, `All phases shipped…`, `Not a JDI project yet…`) |
| `slug`, `dir`, `status`, `verdict`, `loop` | the derived state, for the message below |

Ladder (first match wins): SHIPPED.md → done; REVIEW.md → BLOCKED: `jdi-do`
(fix mode), APPROVED_PENDING_MANUAL: `jdi-confirm-dod`, other verdict:
`jdi-ship`, no verdict: `jdi-verify`; SUMMARY.md → `jdi-verify`; PLAN.md →
`jdi-do`; CONTEXT.md → `jdi-plan`; nothing → `jdi-discuss`. Loop mode turns
`jdi-do`/`jdi-verify` into `jdi-loop`.

- `next` is `null` → print `reason` and stop (new/adopt need the user's
  description; a shipped project needs /jdi-add-phase).
- Otherwise print `Next step for phase {slug}: {next} — executing now.` and
  set `TARGET` (command name without `/`) and `PHASE_SLUG` from it.

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
