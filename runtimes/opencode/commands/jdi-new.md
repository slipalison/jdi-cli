---
name: jdi-new
description: Entry point for new project. Runs research + asker, generates PROJECT.md + ROADMAP.md. --auto (alias --yolo) skips all questions — the researcher decides everything itself, using web/context7 research when available, and records the rationale.
argument_hint: "<short project description> [--reset] [--auto]"
runtime_intent:
  invokes_agent: jdi-researcher
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Bash, Grep, Glob, AskUserQuestion, WebSearch, WebFetch, Agent]
  copilot:
    tools: [read, write, grep, glob, terminal]
  opencode:
    agent: jdi-researcher
    subtask: true
  antigravity:
    triggers:
      - "/jdi-new"
      - "create project"
      - "new app"
---

<objective>
Initializes new JDI project. Runs research + key questions + generates PROJECT.md, ROADMAP.md, STATE.md, DECISIONS.md.
</objective>

<arguments>
- `description` (optional but recommended): short text of what to build.
- `--auto` (alias: `--yolo`): fully autonomous — ZERO questions. Whatever the
  description does not answer, the researcher decides itself (researching via
  context7/web when available, else stack heuristics) and records the
  rationale. D-1 is auto-locked with a 1-line justification. The DoD baseline
  keeps the 5 derived candidates as-is. The richer the description, the fewer
  decisions are guessed — pair `--auto` with a dense prompt.
  `--auto` does NOT bypass the `--reset` confirmation (destructive stays human).

Examples:
- `/jdi-new "TODO app .NET 10 + React 19"`
- `/jdi-new "Inventory REST API in Python + FastAPI" --auto`
- `/jdi-new "Go CLI tool for log parsing"`
- `/jdi-new` (asker starts from scratch)
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ && {
  echo ".jdi/ already exists. Use /jdi-new --reset to start over (CAUTION: wipes state)."
  exit 1
}

# Suggest /jdi-adopt if directory is NOT empty (likely brownfield)
file_count=$(find . -maxdepth 3 -type f \
  -not -path './.git/*' -not -path './node_modules/*' \
  -not -path './.venv/*' -not -path './venv/*' \
  -not -path './target/*' -not -path './dist/*' -not -path './build/*' \
  -not -path './bin/*' -not -path './obj/*' \
  2>/dev/null | wc -l)

if [ "$file_count" -ge 3 ]; then
  # Ask before continuing — could be greenfield in monorepo
  echo "Directory has $file_count code files. Looks like existing project."
  echo "For brownfield projects, /jdi-adopt detects stack/code-design automatically."
  echo "Continue with /jdi-new anyway? (recommended: /jdi-adopt)"
  # AskUserQuestion: [Continue /jdi-new] / [Switch to /jdi-adopt] / [Cancel]
fi
```

PowerShell:
```powershell
if (Test-Path .jdi) { Write-Error ".jdi/ already exists. Use /jdi-new --reset."; exit 1 }
$files = Get-ChildItem -Recurse -File -Depth 3 -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\(\.git|node_modules|\.venv|venv|target|dist|build|bin|obj)\\' }
if ($files.Count -ge 3) {
  Write-Host "Directory has $($files.Count) files. Consider /jdi-adopt instead of /jdi-new."
  # Sequential AskUserQuestion
}
```

If `--reset` passed, AskUserQuestion confirms + wipes `.jdi/`.

### Step 2: Spawn researcher
Invoke `jdi-researcher` passing the description AND `auto=true` when `--auto`
(or its alias `--yolo`) was passed. Wait.

### Step 3: Verify outputs
```bash
test -f .jdi/PROJECT.md || { echo "PROJECT.md not created"; exit 1; }
test -f .jdi/ROADMAP.md || { echo "ROADMAP.md not created"; exit 1; }
test -f .jdi/STATE.md || { echo "STATE.md not created"; exit 1; }
test -f .jdi/DECISIONS.md || { echo "DECISIONS.md not created"; exit 1; }
grep -q '## Definition of Done' .jdi/PROJECT.md || { echo "PROJECT.md missing § Definition of Done"; exit 1; }
```

### Step 4: Create config.json (token/context budget)

If `.jdi/config.json` does not exist yet, write the default from the single
canonical source shipped in the package (`templates-jdi-folder/config.json`,
#57), and record the JDI version this project runs:

```bash
[ -f .jdi/config.json ] || npx -y jdi-cli@0.17.0 template config --out .jdi/config.json
printf '%s' '0.17.0' > .jdi/VERSION
```

The default covers: token budgets per artifact (`budgets`, measured in tokens
with `chars_per_token` per language),
model per role (`models`, `inherit` = the session's model), compaction and
coverage. Edit by hand afterwards when needed.

#### Step 4b: Enhanced orchestration opt-in (host-neutral capability flag)

`orchestration.mode` tells later commands whether they MAY use optional multi-agent layers (advisory critics, parallel analysis), always degrading to the standard path when the host cannot fan out. Default `standard` keeps every command byte-identical on hosts without the capability — never assume it.

Determine the value **once, here, in this top-level command turn** — host capability signals are only visible now; sub-agents spawned by later commands cannot see them, so the choice MUST be persisted to the file:

1. **Default:** if this session is running under an enhanced / high-effort multi-agent orchestration mode, pre-select `enhanced` and set `source: "detected"`. Otherwise `standard`.
2. **Confirm** (AskUserQuestion; fallback: numbered prompt — see `<fallbacks>` convention):
   ```
   Enable enhanced multi-agent orchestration when your assistant supports it?
   Adds opt-in advisory critics (e.g. a Definition-of-Done re-check at /jdi-verify).
   The standard single-agent path is used unchanged whenever it is unavailable.
   ```
   Options: `[Enhanced — use extra agents when available]` / `[Standard — single-agent always (default)]`
3. Write the chosen `mode` into the `orchestration` block; set `source` to `"user"` (or keep `"detected"` if the user accepts the detected default without changing it). **Never** store a token budget here — this is a boolean capability switch, not an accounting ledger.

#### Step 4c: Commit the config

```bash
git add .jdi/config.json .jdi/VERSION
git diff --cached --quiet || git commit -m "chore(jdi): config and version"
```

### Step 5: Confirm

```
{project_name} initialized. {N} phases planned in .jdi/.
Next: /jdi-bootstrap
```

</process>

<gates>
- pre: directory without existing `.jdi/` (or `--reset`)
- post: PROJECT.md + ROADMAP.md + STATE.md + DECISIONS.md + config.json created, initial commit made
</gates>

<errors>
- `.jdi/` already exists -> suggest `--reset` or use current project
- Researcher cancelled -> exit clean
- Researcher failed -> show error, no commit
</errors>
