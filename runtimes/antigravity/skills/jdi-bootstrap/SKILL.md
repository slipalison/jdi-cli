---
name: jdi-bootstrap
description: Creates per-project doer + reviewer specialists. Runs after /jdi-new, before /jdi-discuss.
argument_hint: ""
runtime_intent:
  invokes_agent: jdi-bootstrap
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, edit, terminal]
  opencode:
    agent: jdi-bootstrap
    subtask: true
  antigravity:
    triggers:
      - "/jdi-bootstrap"
      - "prepare specialists"
      - "project setup"
---

<objective>
Generates per-project specialists (doer + reviewer) based on stack/code-design defined in PROJECT.md.
</objective>

<arguments>
None. Reads everything from `.jdi/PROJECT.md`.
</arguments>

<process>

### Step 1: Validation

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y jdi-cli render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).
```bash
test -f .jdi/PROJECT.md || { echo "PROJECT.md missing. Run /jdi-new first."; exit 1; }
test -f .jdi/ROADMAP.md || { echo "ROADMAP.md missing. Run /jdi-new first."; exit 1; }

# Clean working tree preferred (changes confined to .jdi/ tolerated)
DIRTY=$(git status --porcelain 2>/dev/null | grep -vE '^.. \.jdi/' || true)
[ -z "$DIRTY" ] || echo "warn: working tree has changes outside .jdi/ — commit or stash first for clean atomic commits."
```

### Step 2: Spawn jdi-bootstrap
Invoke agent. Wait.

### Step 3: Verify result

Determine first phase identifier from `.jdi/ROADMAP.md` — extract the first `- **Slug:**` value under the phases section. Fall back to integer `1` only on legacy schema v1 projects that lack slugs.

```bash
FIRST_SLUG=$(awk '/^- \*\*Slug:\*\*/{print $NF; exit}' .jdi/ROADMAP.md 2>/dev/null)
NEXT_ID="${FIRST_SLUG:-1}"
```

- created -> show confirmation, suggest `/jdi-discuss $NEXT_ID`
- already-exists + keep -> show "already ready", suggest `/jdi-discuss $NEXT_ID`
- cancelled -> exit clean
- failed -> show error

### Step 4: MCP audit (token budget)

Applicable to runtimes with MCP (Claude Code, OpenCode). Prints checklist after Step 3 confirmation:

```
MCP audit (token budget):
Every enabled MCP injects tool schema in EVERY turn — heavyweight (browser/playwright,
mac-tools, win-tools) costs 20k+ tokens/turn each. Before starting /jdi-discuss:

  [ ] Browser/playwright enabled? Disable if current phases have no UI work
  [ ] Platform-specific (mac-tools/win-tools)? Disable if unused
  [ ] Cross-project MCPs still on from another project?
  [ ] Duplicate MCPs (2 filesystem helpers, 2 search providers)?

Toggle (Claude Code):  .claude/settings.json -> enabledMcpjsonServers / disabledMcpjsonServers
Toggle (OpenCode):     .opencode/opencode.jsonc -> mcp.<name>.enabled
Toggle (Copilot):      n/a (no granular MCP toggle support)

Skip if recently audited.
```

Does not block. Just reminds. JDI does not manage `.claude/settings.json` or `.opencode/opencode.jsonc` — those belong to runtime, not project state.

</process>

<gates>
- pre: `.jdi/PROJECT.md` + `.jdi/ROADMAP.md` exist; dirty tree outside `.jdi/` warns (non-blocking)
- post: `.jdi/agents/jdi-doer-*.md` and `.jdi/agents/jdi-reviewer-*.md` exist + routing updated + commit + MCP audit checklist shown
</gates>

<errors>
- PROJECT.md missing -> suggest `/jdi-new`
- Architect cancelled -> exit clean
- Architect failed -> keep state, show error, suggest manual retry
</errors>
