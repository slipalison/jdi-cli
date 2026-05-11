---
name: jdi-remove-phase
description: Removes a phase from ROADMAP.md. Refuses to remove done phases or the current phase. Archives any existing phase artifacts. Atomic commit.
argument_hint: "<phase_number> [--force]"
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
      - "/jdi-remove-phase"
      - "remove phase"
      - "delete phase"
---

<objective>
Removes a phase from `.jdi/ROADMAP.md`. Refuses to remove the current phase or any phase already shipped. If the phase has artifacts under `.jdi/phases/<NN-slug>/`, moves them to `.jdi/archive/removed-<NN-slug>/` instead of deleting (preserves history).
</objective>

<arguments>
- `phase_number` (required) — number of the phase to remove (as listed in ROADMAP.md).
- `--force` (optional) — required when removing a phase that has any artifacts in `.jdi/phases/`. Without `--force`, the command refuses and explains.

Examples:
- `/jdi-remove-phase 4`
- `/jdi-remove-phase 5 --force`
</arguments>

<process>

### Step 1: Validation

```bash
test -d .jdi/ || { echo "Not a JDI project."; exit 1; }
test -f .jdi/ROADMAP.md || { echo "ROADMAP.md missing."; exit 1; }
test -f .jdi/STATE.md || { echo "STATE.md missing."; exit 1; }

# Argument required
[ -n "$1" ] || { echo "Phase number required. Usage: /jdi-remove-phase <N> [--force]"; exit 1; }
```

Parse `phase_number` (positional). Parse `--force` flag.

### Step 2: Read state

```bash
CURRENT=$(grep -oE 'current_phase:\s*[0-9]+' .jdi/STATE.md | grep -oE '[0-9]+')
TOTAL=$(grep -oE 'total_phases:\s*[0-9]+' .jdi/ROADMAP.md | grep -oE '[0-9]+')
PHASE_NUMBER=$1
```

PowerShell:
```powershell
$current = (Select-String -Path .jdi/STATE.md -Pattern 'current_phase:\s*([0-9]+)').Matches[0].Groups[1].Value -as [int]
$total = (Select-String -Path .jdi/ROADMAP.md -Pattern 'total_phases:\s*([0-9]+)').Matches[0].Groups[1].Value -as [int]
$phaseNumber = [int]$args[0]
```

### Step 3: Hard refuses (no override)

```bash
# Must be in range
if [ "$PHASE_NUMBER" -lt 1 ] || [ "$PHASE_NUMBER" -gt "$TOTAL" ]; then
  echo "Phase $PHASE_NUMBER does not exist. Valid: 1..$TOTAL"
  exit 1
fi

# Cannot remove past phases (preserves history)
if [ "$PHASE_NUMBER" -lt "$CURRENT" ]; then
  echo "Cannot remove phase $PHASE_NUMBER — already past. current_phase is $CURRENT. Past phases are immutable history."
  exit 1
fi

# Cannot remove the current phase
if [ "$PHASE_NUMBER" -eq "$CURRENT" ]; then
  echo "Cannot remove the current phase ($CURRENT). Ship or abandon it first, then advance current_phase."
  exit 1
fi
```

Read the phase's `Status:` from ROADMAP:

```bash
STATUS=$(awk "/### Phase $PHASE_NUMBER:/,/^### Phase /" .jdi/ROADMAP.md | grep -oE 'Status:\*\* (pending|ready|done|partial|blocked|in-progress)' | head -1 | awk '{print $2}')
```

If `STATUS == done`: refuse hard.
```
Phase $PHASE_NUMBER is `done`. Cannot remove. Shipped phases are immutable history.
```

### Step 4: Detect artifacts

Find the phase folder under `.jdi/phases/`:

```bash
NN=$(printf '%02d' "$PHASE_NUMBER")
PHASE_DIR=$(ls -d .jdi/phases/${NN}-*/ 2>/dev/null | head -1 || true)
```

PowerShell:
```powershell
$nn = '{0:D2}' -f $phaseNumber
$phaseDir = Get-ChildItem .jdi/phases/ -Directory -Filter "$nn-*" -ErrorAction SilentlyContinue | Select-Object -First 1
```

If `PHASE_DIR` exists AND `--force` NOT passed: refuse.
```
Phase $PHASE_NUMBER has artifacts in $PHASE_DIR (CONTEXT/PLAN/SUMMARY/REVIEW).
Re-run with --force to archive these artifacts to .jdi/archive/removed-<NN-slug>/ and proceed.
```

### Step 5: Confirm with user (irreversible-ish action)

AskUserQuestion (always run, even with --force):

> "Remove phase $PHASE_NUMBER: '$PHASE_NAME'?
>
> Status: $STATUS
> Artifacts: ${PHASE_DIR:-none}
> Action: ROADMAP section removed, total_phases decremented, artifacts (if any) moved to .jdi/archive/removed-<NN-slug>/."
>
> Options:
> - [Yes, remove]
> - [Cancel]

If "Cancel" -> exit clean.

### Step 6: Archive artifacts (if any)

```bash
if [ -n "$PHASE_DIR" ]; then
  mkdir -p .jdi/archive
  test -f .jdi/archive/index.md || echo "# Archive index" > .jdi/archive/index.md

  BASENAME=$(basename "$PHASE_DIR")
  TARGET=".jdi/archive/removed-$BASENAME"
  mv "$PHASE_DIR" "$TARGET"
  echo "- removed-$BASENAME (removed $(date -u +%F) via /jdi-remove-phase)" >> .jdi/archive/index.md
fi
```

PowerShell:
```powershell
if ($phaseDir) {
  if (-not (Test-Path .jdi/archive)) { New-Item -ItemType Directory .jdi/archive | Out-Null }
  if (-not (Test-Path .jdi/archive/index.md)) { Set-Content .jdi/archive/index.md "# Archive index" }
  $basename = $phaseDir.Name
  $target = ".jdi/archive/removed-$basename"
  Move-Item $phaseDir.FullName $target
  Add-Content .jdi/archive/index.md "- removed-$basename (removed $(Get-Date -Format 'yyyy-MM-dd') via /jdi-remove-phase)"
}
```

### Step 7: Edit ROADMAP.md

Remove the entire `### Phase $PHASE_NUMBER: ...` block (header + bullets) up to (but not including) the next `### Phase ` line or end of file.

Decrement `total_phases`:
```
total_phases: {TOTAL - 1}
```

**Do NOT renumber** subsequent phases. Phases after the removed one keep their original numbers. This preserves all references in commit history, `DECISIONS.md`, and archived phase folders. The roadmap simply has a gap (e.g., 1, 2, 3, 5, 6 — 4 was removed).

### Step 8: Audit trail in DECISIONS.md

Append:
```markdown
D-{N+1} ({date}): Phase $PHASE_NUMBER removed via /jdi-remove-phase. Artifacts: ${PHASE_DIR:+archived to .jdi/archive/removed-<NN-slug>/}{none if empty}.
```

### Step 9: Commit

```bash
git add .jdi/ROADMAP.md .jdi/DECISIONS.md .jdi/archive/ 2>/dev/null
git commit -m "chore(jdi): remove phase {PHASE_NUMBER}"
```

### Step 10: Confirm

```
Phase {PHASE_NUMBER} removed.
{if artifacts:} Artifacts archived: .jdi/archive/removed-{NN-slug}/
total_phases: {TOTAL - 1}

Note: phase numbers are not renumbered — references in commits, DECISIONS, and archive remain valid.
```

</process>

<gates>
- pre: `.jdi/ROADMAP.md` + `.jdi/STATE.md` exist
- pre: `phase_number` is in range `1..total_phases`
- pre: `phase_number > current_phase`
- pre: phase status != `done`
- pre: `--force` provided when phase has artifacts
- post: ROADMAP.md section removed + total_phases decremented + artifacts archived (if any) + DECISIONS.md appended + atomic commit
</gates>

<errors>
- `.jdi/` missing -> "Run /jdi-new first"
- `phase_number` missing -> usage hint
- `phase_number` out of range -> "Valid: 1..{total}"
- `phase_number < current_phase` -> refuse (past = history)
- `phase_number == current_phase` -> refuse (ship or abandon first)
- phase status `done` -> refuse (shipped = history)
- artifacts exist + no `--force` -> refuse + suggest `--force`
- user cancels at AskUserQuestion -> exit clean
</errors>

<runtime_notes>

**Claude Code:**
- Confirms via AskUserQuestion.

**Copilot:**
- AskUserQuestion not always available — require explicit `--yes` flag as fallback.

**OpenCode/Antigravity:**
- Same interactive confirm as Claude. Fallback to `--yes` when prompts unsupported.

</runtime_notes>
