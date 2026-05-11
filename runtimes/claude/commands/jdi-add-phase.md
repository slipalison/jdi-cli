---
name: jdi-add-phase
description: Adds a new phase to ROADMAP.md. Append at end (default) or insert at a specific position. Bumps total_phases. Atomic commit.
argument_hint: "\"<phase name>\" [--goal \"<goal>\"] [--at <position>]"
runtime_intent:
  invokes_agent: none
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion]
  copilot:
    tools: [read, write, edit, grep, glob, terminal]
  opencode:
    subtask: true
  antigravity:
    triggers:
      - "/jdi-add-phase"
      - "add new phase"
      - "create phase"
---

<objective>
Adds a new phase to the project's roadmap. Edits `.jdi/ROADMAP.md`. Does not start the phase — only registers it. The user advances via `/jdi-discuss <N>` when ready.
</objective>

<arguments>
- `name` (required) — short phase name. Quote if it contains spaces.
- `--goal "<text>"` (optional) — 1-line description of what the phase delivers. If missing, AskUserQuestion will prompt.
- `--at <position>` (optional) — insert at this position instead of appending. Existing phases at and after `<position>` shift down by 1 (renumbered in ROADMAP only — slugs stay the same in any existing `.jdi/phases/` folders). Default: append.

Examples:
- `/jdi-add-phase "User authentication" --goal "Login + signup + JWT"`
- `/jdi-add-phase "Performance pass" --at 3`
- `/jdi-add-phase "Hotfix N+1 query"`
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new first."; exit 1; }
test -f .jdi/ROADMAP.md || { echo "ROADMAP.md missing."; exit 1; }
test -f .jdi/STATE.md || { echo "STATE.md missing."; exit 1; }
```

If `<name>` argument missing: AskUserQuestion "Phase name?" (free text). Required.

If `--goal` flag missing: AskUserQuestion "Phase goal (1 line)?" (free text). Required.

### Step 2: Compute phase number + slug

Read `total_phases` from `.jdi/ROADMAP.md`:

```bash
TOTAL=$(grep -oE 'total_phases:\s*[0-9]+' .jdi/ROADMAP.md | grep -oE '[0-9]+')
```

PowerShell:
```powershell
$total = (Select-String -Path .jdi/ROADMAP.md -Pattern 'total_phases:\s*([0-9]+)').Matches[0].Groups[1].Value -as [int]
```

If `--at <pos>` provided, validate `1 <= pos <= total + 1`. Otherwise `pos = total + 1` (append).

If `pos <= current_phase` (read from STATE.md), abort with error: "Cannot insert before current phase {current}. Use --at {current+1} or higher."

Generate `slug` from `name`:
- Lowercase
- Replace accents (à → a, é → e, ç → c, ñ → n)
- Non-alphanumeric → `-`
- Collapse repeated `-`, strip leading/trailing `-`
- Truncate to 40 chars

Phase identifier prefix is the 2-digit position (`NN`): `01`, `02`, ..., zero-padded.

### Step 3: Renumber prefix on shift (only if --at)

If `--at <pos>` shifts existing phases:

Edit `.jdi/ROADMAP.md` — for every existing `### Phase K:` where `K >= pos`, change to `### Phase K+1:` and bump its `**Slug:**` prefix from `KK-...` to `(K+1)(K+1)-...`.

**WARNING (printed):**
> "Renumbering ROADMAP phases. Any existing `.jdi/phases/<NN-slug>/` folders are NOT renamed — they keep their original slugs and become "history". New work in renumbered phases creates new folders. Commits referencing old `phase {K}` remain valid as history."

This is intentional. Do not rename `.jdi/phases/` folders — would break commit history and cross-references in DECISIONS.md.

If `--at` not provided (append), skip Step 3.

### Step 4: Append phase section to ROADMAP.md

If appending (`pos == total + 1`), append at the bottom of `## Phases`:

```markdown

### Phase {pos}: {name}
- **Slug:** {NN}-{slug}
- **Status:** pending
- **Goal:** {goal}
```

If inserting (`pos <= total`), insert the new section BEFORE the section that previously had number `pos` (now renumbered to `pos+1`).

### Step 5: Bump total_phases

Edit `.jdi/ROADMAP.md`:
```
total_phases: {TOTAL + 1}
```

### Step 6: Audit trail in DECISIONS.md (optional, only if user passes --reason)

Not required. If user wants to record why this phase was added mid-project, they pass `--reason "<text>"`. When present, append to `.jdi/DECISIONS.md`:

```markdown
D-{N+1} ({date}, phase {pos}): Phase added mid-project. Reason: {reason}
```

(N = current max D-X.)

### Step 7: Commit

```bash
git add .jdi/ROADMAP.md .jdi/DECISIONS.md 2>/dev/null
git commit -m "chore(jdi): add phase {pos} {NN-slug}"
```

PowerShell:
```powershell
git add .jdi/ROADMAP.md .jdi/DECISIONS.md 2>$null
git commit -m "chore(jdi): add phase $pos $NN-$slug"
```

### Step 8: Confirm

```
Phase {pos}: {name} added.
Slug: {NN}-{slug}
Goal: {goal}
Status: pending
total_phases: {TOTAL + 1}

Next: /jdi-discuss {pos} (when ready to start this phase)
```

</process>

<gates>
- pre: `.jdi/ROADMAP.md` + `.jdi/STATE.md` exist
- pre: `--at <pos>` (if used) is greater than `current_phase` in STATE.md
- post: ROADMAP.md has new phase section + bumped total_phases + atomic commit
</gates>

<errors>
- `.jdi/` missing -> "Run /jdi-new first"
- `--at <pos>` <= current_phase -> "Cannot insert before current phase. Use --at {current+1} or higher."
- `--at <pos>` < 1 or > total+1 -> "Position out of range. Valid: 1..{total+1}"
- Phase name empty -> AskUserQuestion to fill
- Goal empty -> AskUserQuestion to fill
</errors>

<runtime_notes>

**Claude Code:**
- AskUserQuestion handles missing args interactively.

**Copilot:**
- AskUserQuestion not always available — read missing args from prompt body or fail with clear error.

**OpenCode/Antigravity:**
- Same interactive flow as Claude when supported. Otherwise fail with clear error message asking the user to re-invoke with all args.

</runtime_notes>
