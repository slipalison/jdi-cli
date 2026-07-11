---
name: jdi-adopt
description: Entry point for brownfield project (code already exists). Runs jdi-adopter — scan + analysis + confirmation + generates .jdi/ with adopted=true flag. Replaces /jdi-new for existing projects.
argument_hint: "<optional short description>"
runtime_intent:
  invokes_agent: jdi-adopter
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Bash, Grep, Glob, AskUserQuestion, WebSearch, WebFetch, Agent]
  copilot:
    tools: [read, write, grep, glob, terminal]
  opencode:
    agent: jdi-adopter
    subtask: true
  antigravity:
    triggers:
      - "/jdi-adopt"
      - "adopt project"
      - "existing project"
      - "brownfield"
---

<objective>
Add JDI to project that ALREADY HAS CODE. Scan repo, infer stack/code-design, confirm with user (code-design ALWAYS confirmed), generate PROJECT.md + ROADMAP.md + STATE.md + DECISIONS.md with adopted=true flag.
</objective>

<arguments>
- `description` (optional): short text override of what the project does. If omitted, adopter extracts from README.

Examples:
- `/jdi-adopt`
- `/jdi-adopt "Orders REST API, legacy, want to add reporting"`
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ && {
  echo ".jdi/ already exists. Use /jdi-bootstrap if no specialists, OR edit manually."
  exit 1
}

# directory must have code (otherwise use /jdi-new)
file_count=$(find . -maxdepth 3 -type f \
  -not -path './.git/*' -not -path './node_modules/*' \
  -not -path './.venv/*' -not -path './venv/*' \
  -not -path './target/*' -not -path './dist/*' -not -path './build/*' \
  -not -path './bin/*' -not -path './obj/*' \
  2>/dev/null | wc -l)

if [ "$file_count" -lt 3 ]; then
  echo "Directory nearly empty ($file_count files). Use /jdi-new for greenfield."
  exit 1
fi
```

PowerShell:
```powershell
if (Test-Path .jdi) {
  Write-Error ".jdi/ already exists. Use /jdi-bootstrap if no specialists, OR edit manually."
  exit 1
}
$files = Get-ChildItem -Recurse -File -Depth 3 -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\(\.git|node_modules|\.venv|venv|target|dist|build|bin|obj)\\' }
if ($files.Count -lt 3) {
  Write-Error "Directory nearly empty ($($files.Count) files). Use /jdi-new for greenfield."
  exit 1
}
```

### Step 2: Spawn jdi-adopter
Invoke `jdi-adopter` passing description (if any). Wait.

Adopter conducts:
- Automatic scan (manifests, layout, git log, README)
- 5 questions (stack, code-design, vision, new-features, LLM)
- Optional web research (max 2 lookups)
- Generation of `.jdi/` files
- Initial commit

### Step 3: Verify outputs
```bash
test -f .jdi/PROJECT.md  || { echo "PROJECT.md not created"; exit 1; }
test -f .jdi/ROADMAP.md  || { echo "ROADMAP.md not created"; exit 1; }
test -f .jdi/STATE.md    || { echo "STATE.md not created"; exit 1; }
test -f .jdi/DECISIONS.md|| { echo "DECISIONS.md not created"; exit 1; }

grep -q '^adopted: true' .jdi/STATE.md || echo "warn: adopted flag missing in STATE.md"
grep -q '^D-2 ' .jdi/DECISIONS.md || echo "warn: D-2 (boundary) missing in DECISIONS.md"
```

PowerShell:
```powershell
foreach ($f in @('PROJECT.md','ROADMAP.md','STATE.md','DECISIONS.md')) {
  if (-not (Test-Path ".jdi/$f")) { Write-Error "$f not created"; exit 1 }
}
if (-not (Select-String -Path .jdi/STATE.md -Pattern '^adopted:\s*true' -Quiet)) {
  Write-Warning "adopted flag missing in STATE.md"
}
if (-not (Select-String -Path .jdi/DECISIONS.md -Pattern '^D-2 ' -Quiet)) {
  Write-Warning "D-2 (boundary) missing in DECISIONS.md"
}
```

### Step 4: Create config.json (token/context budget)

If `.jdi/config.json` does not yet exist, write default identical to `/jdi-new`:

```json
{
  "$schema_version": "1.2",
  "context_window": 200000,
  "thresholds": {
    "warn_pct": 60,
    "critical_pct": 70
  },
  "budgets": {
    "max_context_chars": 6000,
    "max_plan_chars": 12000,
    "max_summary_chars": 8192
  },
  "compaction": {
    "archive_after": 5
  },
  "orchestration": {
    "mode": "standard",
    "source": "default"
  },
  "coverage_min": 80
}
```

#### Step 4b: Enhanced orchestration opt-in (host-neutral capability flag)

Identical to `/jdi-new` Step 4b. `orchestration.mode` lets later commands use optional multi-agent layers only when the host can fan out — default `standard` keeps every command byte-identical otherwise. Decide **here, in this top-level turn** (sub-agents cannot see host capability signals; the choice must live in the file):

1. **Default:** if this session runs under an enhanced / high-effort multi-agent orchestration mode, pre-select `enhanced` (`source: "detected"`); else `standard`.
2. **Confirm** (AskUserQuestion; fallback: numbered prompt): "Enable enhanced multi-agent orchestration when your assistant supports it? Adds opt-in advisory critics (e.g. a DoD re-check at /jdi-verify); standard path unchanged when unavailable." Options: `[Enhanced — use extra agents when available]` / `[Standard — single-agent always (default)]`.
3. Write `mode` into the `orchestration` block; set `source` to `"user"` (or keep `"detected"`). Never store a token budget — boolean capability switch, not a ledger.

### Step 5: Confirm

```
{project_name} adopted. {N} new phases planned.
Existing assets captured in .jdi/PROJECT.md (context, NOT TODO).
Code design: {design} (LOCKED after confirm).
Boundary: legacy code does not enforce 80% coverage (D-2 in DECISIONS.md).
Next: /jdi-bootstrap
```

</process>

<gates>
- pre: `.jdi/` missing + directory with >= 3 code files (excluding ignored)
- post: PROJECT.md (with `## Existing assets`) + ROADMAP.md (adopted=true) + STATE.md (adopted: true) + DECISIONS.md (D-1 code-design, D-2 boundary) + config.json created, commit made
</gates>

<errors>
- `.jdi/` already exists -> exit with instruction
- Directory nearly empty -> suggest `/jdi-new` instead of adopt
- Adopter cancelled -> exit clean, no commit
- Adopter failed -> show error, no commit, suggest manual retry
- Code design not confirmed by user -> abort (rule: ALWAYS confirm)
</errors>
