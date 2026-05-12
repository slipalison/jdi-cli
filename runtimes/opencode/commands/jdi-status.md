---
name: jdi-status
description: Prints a compact summary of where the project is — current phase, what the last action did, and the exact next command to run. Read-only. No agent invoked.
argument_hint: ""
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
None.
</arguments>

<process>

### Step 1: Validation

```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new first."; exit 1; }
test -f .jdi/STATE.md || { echo "STATE.md missing — broken project."; exit 1; }
```

### Step 2: Read state

```bash
PROJECT_SLUG=$(grep -oE 'project_slug:\s*\S+' .jdi/STATE.md | awk '{print $2}')
CURRENT=$(grep -oE 'current_phase:\s*[0-9]+' .jdi/STATE.md | grep -oE '[0-9]+')
PHASE_STATUS=$(grep -oE 'phase_status:\s*[a-z_-]+' .jdi/STATE.md | awk '{print $2}')
VERDICT=$(grep -oE 'phase_verdict:\s*[A-Z_]+' .jdi/STATE.md | awk '{print $2}')
NEXT_STEP=$(grep -E '^next_step:' .jdi/STATE.md | sed -E 's/^next_step:[[:space:]]*//')

# Phase name from ROADMAP
PHASE_NAME=$(awk "/^### Phase $CURRENT:/{sub(/^### Phase $CURRENT:[[:space:]]*/, \"\"); print; exit}" .jdi/ROADMAP.md 2>/dev/null)
TOTAL=$(grep -oE 'total_phases:\s*[0-9]+' .jdi/ROADMAP.md | grep -oE '[0-9]+')

NN=$(printf '%02d' "$CURRENT")
PHASE_DIR=$(ls -d .jdi/phases/${NN}-*/ 2>/dev/null | head -1 | sed 's|/$||')
```

PowerShell:
```powershell
$state = Get-Content .jdi/STATE.md -Raw
$projectSlug = ([regex]::Match($state, 'project_slug:\s*(\S+)')).Groups[1].Value
$current = [int]([regex]::Match($state, 'current_phase:\s*([0-9]+)')).Groups[1].Value
$phaseStatus = ([regex]::Match($state, 'phase_status:\s*([a-z_-]+)')).Groups[1].Value
$verdict = ([regex]::Match($state, 'phase_verdict:\s*([A-Z_]+)')).Groups[1].Value
$nextStep = ([regex]::Match($state, '(?m)^next_step:\s*(.+)$')).Groups[1].Value.Trim()

$roadmap = Get-Content .jdi/ROADMAP.md -Raw
$phaseName = ([regex]::Match($roadmap, "(?m)^### Phase $current`:\s*(.+)$")).Groups[1].Value.Trim()
$total = [int]([regex]::Match($roadmap, 'total_phases:\s*([0-9]+)')).Groups[1].Value

$nn = '{0:D2}' -f $current
$phaseDir = (Get-ChildItem .jdi/phases/ -Directory -Filter "$nn-*" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
```

### Step 3: Detect last artifact in current phase

Priority order (most recent stage first): `REVIEW.md` -> `SUMMARY.md` -> `PLAN.md` -> `CONTEXT.md`.

```bash
LAST_ARTIFACT=""
LAST_ARTIFACT_PATH=""
if [ -n "$PHASE_DIR" ]; then
  for f in REVIEW.md SUMMARY.md PLAN.md CONTEXT.md; do
    if [ -f "$PHASE_DIR/$f" ]; then
      LAST_ARTIFACT="$f"
      LAST_ARTIFACT_PATH="$PHASE_DIR/$f"
      break
    fi
  done
fi
```

PowerShell:
```powershell
$lastArtifact = ""
$lastArtifactPath = ""
if ($phaseDir) {
  foreach ($f in @('REVIEW.md', 'SUMMARY.md', 'PLAN.md', 'CONTEXT.md')) {
    $candidate = Join-Path $phaseDir $f
    if (Test-Path $candidate) {
      $lastArtifact = $f
      $lastArtifactPath = $candidate
      break
    }
  }
}
```

### Step 4: Pull one-line summary from the last artifact

Extract a 1-line headline so the user sees what was last produced without opening the file.

- `REVIEW.md`: pull the `**Veredicto:**` / `**Verdict:**` line + 1-line "Recomendacao".
- `SUMMARY.md`: pull `**Status:**` + `**Tasks:**` line.
- `PLAN.md`: pull `Total tasks:` and `Waves:` from the Execution section.
- `CONTEXT.md`: pull the `## Goal` line.

```bash
HEADLINE=""
if [ -n "$LAST_ARTIFACT_PATH" ]; then
  case "$LAST_ARTIFACT" in
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

PowerShell:
```powershell
$lastCommit = & git log -1 --format='%h  %s' 2>$null
if (-not $lastCommit) { $lastCommit = '(no commits yet)' }
$commitsToday = (& git log --since=midnight --format='%h' 2>$null | Measure-Object).Count
```

### Step 6: Print

```
══════════════════════════════════════════════════
  JDI status
══════════════════════════════════════════════════
  Project:        {project_slug}
  Phase:          {current}/{total} — {phase_name}
  Phase status:   {phase_status}
  Verdict:        {verdict or "—"}

  Last artifact:  {last_artifact}
                  {path}
                  {headline}

  Last commit:    {hash}  {subject}
  Commits today:  {commits_today}

══════════════════════════════════════════════════
  Next step:      {next_step}
══════════════════════════════════════════════════
```

**Empty-state messages:**

- `{verdict}` empty when phase not yet verified -> print `—`.
- `{last_artifact}` empty when no phase artifacts yet (e.g. right after `/jdi-bootstrap`) -> print `(none — phase has not started)`.
- `{next_step}` empty -> print `(STATE.md missing next_step — possibly corrupted state)`.

### Step 7: Optional flags (future)

Reserved for later, do not implement now:
- `--verbose` -> dump full last artifact body (truncated to first 40 lines).
- `--json` -> emit machine-readable JSON for pipelines.

</process>

<gates>
- pre: `.jdi/` exists + STATE.md exists
- post: status snapshot printed. No files modified. No commit. No agent spawned.
</gates>

<errors>
- `.jdi/` missing -> "Run /jdi-new first"
- STATE.md missing -> abort with corrupted-state message
- ROADMAP.md missing -> warn and continue (some fields empty)
- Not a git repo -> commit fields print "(no commits yet)" — does not fail
</errors>

<runtime_notes>

**Claude Code:**
- Pure Bash + Grep + Read. No Agent invocation.

**Copilot:**
- Same — terminal-driven.

**OpenCode/Antigravity:**
- Same — pure shell. Antigravity triggers also fire on natural-language phrases like "where did we stop", "what's next".

</runtime_notes>
