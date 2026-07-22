---
name: jdi-issue
description: Fully autonomous intake — turn a task/issue/card (GitHub, Linear, Jira, Azure DevOps, Trello, or pasted text) into shipped work with a pull request at the end, no human in the loop. Compensates the missing human with harder gates — DoD critic forced on, warnings get a fix round, hard iteration fuses. Humans return only to review the PR.
argument_hint: "<issue-url | card-id | card text> [--no-pr]"
runtime_intent:
  invokes_agent: dynamic
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, Agent]
  copilot:
    tools: [read, write, edit, grep, glob, terminal]
  opencode:
    subtask: true
  antigravity:
    triggers:
      - "/jdi-issue"
      - "work on this issue autonomously"
      - "take this card and implement it"
      - "implement this task end to end"
---

<objective>
Card in → pull request out, autonomously. Chains add-phase → discuss --auto →
plan → loop → ship --pr in one invocation with ZERO questions. Autonomy is
earned by rigor, not by skipping checks: every chained gate stays active, the
DoD critic is forced on, warnings get a dedicated fix round, and the loop's
hard caps are the fuse — when quality cannot be proven, the chain STOPS and
reports instead of shipping. The human's judgment moves to where it belongs:
reviewing the pull request.
</objective>

<arguments>
- `card` (required): where the work comes from —
  - **GitHub issue URL** → read via `gh issue view`
  - **Other tracker URL/ID** (Linear, Jira, Azure DevOps, Trello, …) → read via
    that provider's **MCP tools when connected** in the runtime
  - **Pasted card text** → universal fallback (title + description + acceptance criteria)
- `--no-pr` (optional): stop after ship without opening the pull request.
</arguments>

<process>

### Step 1: Validation

```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new (or /jdi-adopt) + /jdi-bootstrap first."; exit 1; }
test -f .jdi/PROJECT.md || { echo "PROJECT.md missing. /jdi-new first."; exit 1; }
ls .jdi/agents/jdi-doer-*.md >/dev/null 2>&1 || { echo "Specialists missing. /jdi-bootstrap first."; exit 1; }

WITH_PR=true
for a in "$@"; do [ "$a" = "--no-pr" ] && WITH_PR=false; done
```

### Step 2: Read the card (provider ladder)

Resolve the card content through the first rung that works:

1. **GitHub URL** (`https://github.com/.../issues/N`) + `gh` available:
   ```bash
   gh issue view "$CARD_ARG" --json title,body,url
   ```
2. **Provider MCP**: if the argument looks like a tracker URL or ID
   (`linear.app/...`, `atlassian.net/browse/KEY-123`, `dev.azure.com/...`,
   `trello.com/c/...`, or a bare `KEY-123`) AND the runtime has that
   provider's MCP tools connected (search available tools for `linear`,
   `jira`/`atlassian`, `azure`/`devops`, `trello`) → fetch the card via MCP
   (title, description, acceptance criteria, labels).
3. **Pasted text**: anything else → the argument IS the card (first line =
   title). This rung always works — no provider dependency.

If rungs 1-2 both fail for a URL (no gh, no MCP): print ONE instruction —
"paste the card text: /jdi-issue \"<title>\n<body>\"" — and exit 0. This is
the only stop before the chain starts.

Extract: **title**, **goal** (1-line distillation), **acceptance criteria**
(`- [ ]` checklists, "acceptance"/"done when" sections), **source url/id**.

### Step 3: Register the phase

```bash
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)
npx -y jdi-cli validate-slug "$SLUG" --check-unique || SLUG="${SLUG}-2"
```

Follow the INSTALLED `/jdi-add-phase` process with
`"$TITLE" --slug $SLUG --goal "<goal>" --reason "<source url/id>"`.
(Installed command paths per runtime — same as /jdi-next: `.claude/commands/`,
`.github/prompts/`, `.opencode/commands/`, Antigravity skill. Not found →
print the manual command and exit 0; never improvise another command's process.)

### Step 4: Discuss — card as primary source, DoD auto-verifiable only

Follow the installed `/jdi-discuss` process for `$SLUG` with:

```
asker dispatch: phase_slug=$SLUG, mode=auto, dod=auto_only, brief=<full card text + source url>
```

- The brief is the PRIMARY source: card constraints → locked decisions; card
  acceptance criteria → DoD candidates.
- `dod=auto_only`: every DoD item MUST carry an executable `Verify:` (a
  command, grep, or file assertion that PROVES it). Criteria that are
  inherently human ("stakeholder approves the visual") are NOT dropped —
  they are recorded under `## Deferred to PR review` in CONTEXT.md and
  surfaced in the PR body (Step 7). No human means no MANUAL_REQUIRED rows —
  and no silent waivers either: deferred items stay visible to the PR reviewer.
- Research caps apply as always (context7/web, max 2 lookups).

### Step 5: Plan + loop (autonomous variant, fuses intact)

- Follow the installed `/jdi-plan` process for `$SLUG`.
- Follow the installed `/jdi-loop` process with ONE deviation, declared here:
  at the loop's human gate (iter cap or oscillation), do NOT ask — take the
  `Continue` branch automatically, appending `--- AUTO-RESET n (reason) ---`
  to LOOP.md. All hard caps stay: max 3 resets, 15 iterations absolute, then
  `killed`. A killed loop is a FULL STOP — killed work is never shipped;
  autonomy ends where proof of quality ends.
- **Force the critic**: when following `/jdi-verify` (inside the loop), run
  Step 4.5 (DoD critic) whenever the runtime can spawn read-only sub-agents —
  regardless of `orchestration.mode`. No human is watching; the critic is the
  skeptic in the room. (The critic can only tighten the verdict, never loosen it.)

### Step 6: Warnings get one fix round (stricter than interactive)

Interactive mode asks "ship anyway?" on APPROVED_WITH_WARNINGS. Autonomous
mode does better: dispatch ONE extra doer pass targeting the warnings
(`mode=fix_blockers` semantics, warnings as the work list), then ONE re-verify.
- Warnings cleared → proceed as APPROVED.
- Warnings persist → proceed, but every remaining warning is listed in the PR
  body under `## Shipped with warnings` (the PR reviewer sees exactly what the
  machine could not fix). This costs at most one loop iteration and only runs
  when the loop converged WITH_WARNINGS.

### Step 7: Ship + PR

| Outcome | Action |
|---|---|
| APPROVED (incl. warnings cleared in Step 6) | follow `/jdi-ship $SLUG` — with `--pr` unless `--no-pr` |
| APPROVED_WITH_WARNINGS (persisting) | ship `--pr`; PR body gains `## Shipped with warnings` |
| Loop `killed` / `escalated` | NO ship. Full stop report with LOOP.md state |

PR body additions in autonomous mode (on top of ship's standard body):
- `Source: <card url/id>`
- `## Deferred to PR review` — the inherently-human criteria from Step 4
- `## Shipped with warnings` — only if Step 6 left any
- The verdict, loop stats (iterations/resets), and `§ Learnings`

### Step 8: Final report (one screen)

```
══════════════════════════════════════════
  /jdi-issue — {SLUG}   [autonomous]
══════════════════════════════════════════
  Card:      {title} ({source})
  Phase:     {SLUG}  (ROADMAP position {N})
  Verdict:   {final verdict}  (critic: {ran|unavailable})
  Loop:      {iters} iterations, {auto-resets} auto-resets
  Warnings:  {cleared in fix round | N listed in PR | none}
  Shipped:   {yes | NO — killed at iteration {i}, see LOOP.md}
  PR:        {url | skipped (--no-pr) | not opened (no ship)}
  Human:     review the PR — deferred items: {N}
══════════════════════════════════════════
```

</process>

<gates>
- pre: `.jdi/` + PROJECT.md + specialists exist (bootstrap done)
- post: one new phase registered; chain advanced exactly as far as its gates allow; every stop state printed with the LOOP.md/REVIEW.md evidence path
- invariant: killed/escalated work is NEVER shipped; the PR is NEVER merged by JDI; no gate of any chained command is weakened — autonomous mode only ADDS rigor (forced critic, warning fix round, deferred-items disclosure)
</gates>

<errors>
- No `.jdi/` / no specialists → point to /jdi-new + /jdi-bootstrap
- Tracker URL with neither gh nor a provider MCP → single paste instruction, exit clean
- Slug collision → automatic `-2` suffix (validated again)
- Installed command file not found → print the manual command, exit 0
- Loop killed → full stop, audited, nothing shipped
</errors>

<runtime_notes>

**Claude Code:**
- Reads each target command from `.claude/commands/` and executes its process inline. Provider MCPs (Linear/Jira/Azure DevOps/Trello) are discovered among available tools when connected.

**Copilot (interactive — VS Code chat / Copilot CLI):**
- Same via `.github/prompts/` (VS Code) or `.github/skills/` (CLI); sub-agent steps degrade to sequential; the forced critic is skipped if sub-agents are unavailable (deterministic gates still run).

**Copilot (coding agent — issue DELEGATED via GitHub/Linear):**
- A delegated session is a different surface: single auto-selected persona, headless, no sub-agents. The session MUST run as the `jdi-solo` agent (`.github/agents/jdi-solo.agent.md`), which executes this whole chain inline — artifacts before code, gates executed, explicit `git add` per artifact, `validate-phase --for-pr` green before the PR.
- Mechanical enforcement (independent of persona choice): `.githooks/pre-commit` (enabled in-session by `copilot-setup-steps.yml`) blocks code commits without staged phase artifacts; `.github/workflows/jdi-artifacts-gate.yml` turns a non-compliant `copilot/*` PR red. Agent PRs need one human click on "Approve and run workflows" for CI to speak.
- Fallback for maximum fidelity (real sub-agents + forced critic): run this command headless in a runner instead — e.g. a workflow that calls Claude Code/Copilot CLI with `/jdi-issue <url>` on issue-labeled events.

**OpenCode/Antigravity:**
- Same pattern via `.opencode/commands/` or the skill folder.

**CI/webhook usage (the proactive trigger lives OUTSIDE JDI):**
- Any pipeline can invoke the runtime headless with `/jdi-issue <url>` on issue-labeled events (GitHub Actions, Linear webhook → runner, Jira automation). JDI stays daemon-free — the runtime is the executor, JDI is the workflow.

</runtime_notes>
