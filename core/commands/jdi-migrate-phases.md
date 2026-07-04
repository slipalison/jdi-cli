---
name: jdi-migrate-phases
description: Migrates a v1 project (numeric NN-slug phase folders) to v2 (slug-as-ID schema). Non-destructive — does NOT rename existing folders. Adds schema_version + phases.json manifest. Idempotent.
argument_hint: "[--dry-run] [--force]"
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
      - "/jdi-migrate-phases"
      - "migrate phases"
      - "upgrade schema"
      - "schema v2"
---

<objective>
Migrate a JDI project from v1 schema (numeric phase IDs, `NN-slug/` folders) to v2 schema (slug-as-ID). Required step before multiple developers can safely create phases in parallel — numeric IDs are race-prone, slugs are not.

Migration is **non-destructive**:
- Existing `NN-slug/` folders are NOT renamed (preserves git history references)
- ROADMAP.md keeps its `### Phase N:` headings (display ordering) and existing `Slug: NN-slug` values
- A new `.jdi/phases.json` manifest maps positions ↔ slugs for fast lookup
- `STATE.md` gains `schema_version: 2`
- Future `/jdi-add-phase` creates v2-style folders (`slug/` without NN prefix)

Idempotent: re-running on an already-migrated project is a no-op (reports current state and exits 0).
</objective>

<arguments>
- `--dry-run` (optional): show what would change without writing.
- `--force` (optional): bypass clean-working-tree gate (only with explicit user awareness).

Examples:
- `/jdi-migrate-phases --dry-run`
- `/jdi-migrate-phases`
</arguments>

<process>

### Step 1: Validation

```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new first."; exit 1; }
test -f .jdi/STATE.md || { echo "STATE.md missing — corrupt project."; exit 1; }
test -f .jdi/ROADMAP.md || { echo "ROADMAP.md missing — corrupt project."; exit 1; }

# Working tree must be clean (or --force) so the migration commit is auditable
if [ "${1:-}" != "--force" ] && [ "${2:-}" != "--force" ]; then
  if ! git diff --quiet HEAD -- .jdi/ 2>/dev/null; then
    echo "Working tree has uncommitted changes in .jdi/. Commit or stash first, or pass --force."
    exit 1
  fi
fi
```

PowerShell:
```powershell
if (-not (Test-Path .jdi)) { Write-Error "Not a JDI project. /jdi-new first."; exit 1 }
if (-not (Test-Path .jdi/STATE.md)) { Write-Error "STATE.md missing."; exit 1 }
if (-not (Test-Path .jdi/ROADMAP.md)) { Write-Error "ROADMAP.md missing."; exit 1 }

if (-not ($args -contains '--force')) {
  $dirty = git diff --quiet HEAD -- .jdi/ 2>$null; if ($LASTEXITCODE -ne 0) {
    Write-Error "Working tree has uncommitted changes in .jdi/. Commit/stash first, or pass --force."
    exit 1
  }
}
```

### Step 2: Detect current schema

```bash
CURRENT_SCHEMA=1
SV=$(grep -oE 'schema_version:\s*[0-9]+' .jdi/STATE.md | grep -oE '[0-9]+' | head -1 || true)
[ -n "$SV" ] && CURRENT_SCHEMA=$SV

if [ "$CURRENT_SCHEMA" -ge 2 ]; then
  echo "Project already on schema v$CURRENT_SCHEMA. Nothing to migrate."
  test -f .jdi/phases.json && echo "Manifest: .jdi/phases.json present."
  exit 0
fi
```

### Step 3: Audit existing phases

Walk `.jdi/phases/` and parse ROADMAP.md. Build mapping `position → {raw_slug, canonical_slug, folder, status}`.

Strict checks (any failure aborts migration with a named error):

- **C1 — Folder/ROADMAP parity:** every ROADMAP phase with a folder must match by canonical slug. Mismatch ⇒ abort, list offenders.
- **C2 — No duplicate canonical slugs:** if two folders have the same canonical slug (e.g. `01-auth/` and `auth/`), abort. User must merge or rename manually.
- **C3 — No invalid slugs:** every existing slug must pass `npx -y jdi-cli validate-slug` shape rules. Pre-existing malformed slugs (mixed case, underscores) ⇒ abort with a remediation hint (rename + commit before re-running).
- **C4 — No orphan folders:** folders without a ROADMAP entry ⇒ warn, do not block (user may have removed phase from ROADMAP without archiving).

```bash
errors=0
phases=()

# Collect ROADMAP rows (position, raw_slug, status)
while IFS=$'\t' read -r pos raw status; do
  [ -z "$pos" ] && continue
  canonical=$(echo "$raw" | sed -E 's/^[0-9]+-//')

  # Shape check (C3)
  if ! npx -y jdi-cli validate-slug "$canonical" >/dev/null 2>&1; then
    echo "C3 FAIL: phase $pos slug '$canonical' has invalid shape"
    errors=$((errors + 1))
  fi

  folder=""
  if [ -d ".jdi/phases/$canonical" ]; then folder=".jdi/phases/$canonical"
  elif [ -d ".jdi/phases/$raw" ]; then folder=".jdi/phases/$raw"; fi

  phases+=("$pos|$raw|$canonical|$status|$folder")
done < <(awk '
  /^### Phase / {
    line = $0
    sub(/^### Phase /, "", line)
    pos = line + 0
    sub(/^[0-9]+:[[:space:]]*/, "", line)
    next
  }
  /^- \*\*Slug:\*\*/ {
    slug = $0
    sub(/^- \*\*Slug:\*\*[[:space:]]*/, "", slug)
    raw = slug
    next
  }
  /^- \*\*Status:\*\*/ {
    s = $0
    sub(/^- \*\*Status:\*\*[[:space:]]*/, "", s)
    if (pos && raw) print pos "\t" raw "\t" s
    pos=0; raw=""
  }
' .jdi/ROADMAP.md)

# C2 — duplicate canonical
duplicates=$(echo "${phases[@]}" | tr ' ' '\n' | awk -F'|' '{print $3}' | sort | uniq -d)
if [ -n "$duplicates" ]; then
  echo "C2 FAIL: duplicate canonical slug(s): $duplicates"
  errors=$((errors + 1))
fi

# C4 — orphan folders (warn only)
for dir in .jdi/phases/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  canonical=$(echo "$name" | sed -E 's/^[0-9]+-//')
  found=false
  for p in "${phases[@]}"; do
    pc=$(echo "$p" | cut -d'|' -f3)
    [ "$pc" = "$canonical" ] && found=true && break
  done
  $found || echo "WARN: orphan folder $dir (not listed in ROADMAP — may have been removed manually)"
done

if [ "$errors" -gt 0 ]; then
  echo "$errors blocker(s). Migration aborted. Fix and re-run."
  exit 1
fi
```

PowerShell parallel implementation lives in `bin/lib/jdi-migrate-phases.ps1` (mirror of this logic). When the command runs under PowerShell, call that script instead of the inline `bash` block above.

### Step 4: Show plan (always — dry-run or not)

```
Migration plan (v1 → v2):

Schema version:       1 → 2
ROADMAP phases:       {N} phases
Existing folders:     {M} folders (kept under current names — NOT renamed)
Manifest:             .jdi/phases.json (new file)
Future phases:        new folder layout = .jdi/phases/<slug>/ (no NN prefix)

Phases detected:
  Pos | Canonical slug    | Folder (existing)             | Status
  ----+-------------------+-------------------------------+--------
   1  | setup-api         | .jdi/phases/01-setup-api      | done
   2  | auth-flow         | .jdi/phases/02-auth-flow      | done
   3  | payments          | (none — not started yet)      | pending
   ...

This is non-destructive. Old folders stay. New phases use slug-only naming.
```

### Step 5: Confirm (skip if --dry-run)

```bash
if [ "${1:-}" = "--dry-run" ] || [ "${2:-}" = "--dry-run" ]; then
  echo "Dry-run complete. No changes written."
  exit 0
fi
```

AskUserQuestion: "Apply migration?"
- [Yes, migrate]
- [Cancel]

If Cancel: exit 0 clean.

### Step 6: Write manifest

`.jdi/phases.json`:

```json
{
  "schema_version": 2,
  "migrated_at": "<ISO-8601 UTC>",
  "phases": [
    {
      "position": 1,
      "slug": "setup-api",
      "raw_slug": "01-setup-api",
      "folder": ".jdi/phases/01-setup-api",
      "status": "done",
      "legacy": true
    },
    {
      "position": 3,
      "slug": "payments",
      "raw_slug": "payments",
      "folder": ".jdi/phases/payments",
      "status": "pending",
      "legacy": false
    }
  ]
}
```

The `legacy: true` flag marks folders still using the v1 naming. Commands use it to know they must use the legacy folder path even when the canonical slug is shorter.

```bash
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

{
  printf '{\n'
  printf '  "schema_version": 2,\n'
  printf '  "migrated_at": "%s",\n' "$ts"
  printf '  "phases": [\n'

  first=true
  for p in "${phases[@]}"; do
    pos=$(echo "$p" | cut -d'|' -f1)
    raw=$(echo "$p" | cut -d'|' -f2)
    canonical=$(echo "$p" | cut -d'|' -f3)
    status=$(echo "$p" | cut -d'|' -f4)
    folder=$(echo "$p" | cut -d'|' -f5)
    [ -z "$folder" ] && folder=".jdi/phases/$canonical"
    legacy=true
    [ "$raw" = "$canonical" ] && legacy=false

    $first || printf ',\n'
    first=false

    printf '    {\n'
    printf '      "position": %s,\n' "$pos"
    printf '      "slug": "%s",\n' "$canonical"
    printf '      "raw_slug": "%s",\n' "$raw"
    printf '      "folder": "%s",\n' "$folder"
    printf '      "status": "%s",\n' "$status"
    printf '      "legacy": %s\n' "$legacy"
    printf '    }'
  done

  printf '\n  ]\n}\n'
} > .jdi/phases.json
```

### Step 7: Update STATE.md

Add `schema_version: 2` line near the top (after `project_slug`). If `current_phase` is still numeric (`current_phase: 5`), add a sibling line `current_phase_slug: <resolved slug>` so commands can pick either. Future writes use `current_phase: <slug>` exclusively.

```bash
# Resolve current slug
CURRENT_INT=$(grep -oE 'current_phase:\s*[0-9]+' .jdi/STATE.md | grep -oE '[0-9]+' | head -1 || true)
CURRENT_SLUG=""
if [ -n "$CURRENT_INT" ]; then
  for p in "${phases[@]}"; do
    pp=$(echo "$p" | cut -d'|' -f1)
    if [ "$pp" = "$CURRENT_INT" ]; then
      CURRENT_SLUG=$(echo "$p" | cut -d'|' -f3)
      break
    fi
  done
fi

# Idempotent insert/update
if grep -qE '^schema_version:' .jdi/STATE.md; then
  sed -i.bak -E 's/^schema_version:.*$/schema_version: 2/' .jdi/STATE.md
else
  # Insert after the first project_slug line
  awk '
    /^project_slug:/ && !inserted { print; print "schema_version: 2"; inserted=1; next }
    { print }
    END { if (!inserted) print "schema_version: 2" }
  ' .jdi/STATE.md > .jdi/STATE.md.tmp && mv .jdi/STATE.md.tmp .jdi/STATE.md
fi

# Add current_phase_slug if missing
if [ -n "$CURRENT_SLUG" ] && ! grep -qE '^current_phase_slug:' .jdi/STATE.md; then
  awk -v s="$CURRENT_SLUG" '
    /^current_phase:/ { print; print "current_phase_slug: " s; next }
    { print }
  ' .jdi/STATE.md > .jdi/STATE.md.tmp && mv .jdi/STATE.md.tmp .jdi/STATE.md
fi

rm -f .jdi/STATE.md.bak
```

PowerShell parity uses `Get-Content`/`Set-Content` with regex replace — see `bin/lib/jdi-migrate-phases.ps1` for the exact mirror.

### Step 8: Commit

```bash
git add .jdi/STATE.md .jdi/phases.json
git commit -m "chore(jdi): migrate to schema v2 (slug-as-ID)"
```

### Step 9: Confirm

```
Migration complete.
  schema_version:   1 → 2
  phases.json:      created ({N} entries, {M} legacy folders preserved)
  STATE.md:         schema_version + current_phase_slug added

Existing phase folders kept under their original names (history preserved).
New phases will use slug-only folders. Multi-developer parallel adds are
now safe — slug uniqueness is enforced by /jdi-add-phase.

Next:
  /jdi-status                 # verify state
  /jdi-add-phase "new feature"  # creates .jdi/phases/new-feature/ (no NN prefix)
```

</process>

<gates>
- pre: `.jdi/STATE.md` + `.jdi/ROADMAP.md` exist
- pre: clean working tree in `.jdi/` (unless `--force`)
- pre: no parity/duplicate/shape errors found in audit (Step 3)
- post (if not `--dry-run`): `.jdi/phases.json` created + `STATE.md` gains `schema_version: 2` + atomic commit
- invariant: no folder renamed under any circumstance
</gates>

<errors>
- `.jdi/` missing → "Run /jdi-new first"
- Already v2 → no-op, exit 0 with status report
- Dirty working tree without `--force` → refuse with instruction
- C1/C2/C3 failures → exit 1, list offenders, no writes
- User cancels at confirmation → exit 0 clean
</errors>

<rules>
- NEVER rename existing folders — history references in git/DECISIONS.md must remain valid
- NEVER discard `raw_slug` for legacy phases — commands need it to resolve folder paths
- Migration is one-way: once v2, no `--rollback` (downgrading is meaningless and risky)
- Re-running on v2 project is a no-op, not an error
- Audit step (C1-C3) MUST run even with `--force` — `--force` only bypasses the working-tree gate
</rules>

<runtime_notes>

**Claude Code:**
- AskUserQuestion for Step 5 confirmation.
- Bash for the audit and manifest write; resolver lib provides slug validation.

**Copilot:**
- AskUserQuestion may be unavailable — fall back to a `--yes` flag required at invocation.

**OpenCode/Antigravity:**
- Same interactive flow as Claude when supported. Otherwise require `--yes`.

</runtime_notes>
