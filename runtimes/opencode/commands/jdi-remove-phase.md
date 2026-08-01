---
name: jdi-remove-phase
description: Removes a phase from ROADMAP.md. Accepts slug OR position. Refuses to remove done/current/past phases. Archives any existing phase artifacts. Atomic commit.
argument_hint: "<slug|position> [--force]"
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
Removes a phase from `.jdi/ROADMAP.md`. Refuses to remove the current phase or any phase already shipped. If the phase has artifacts under `.jdi/phases/<dir>/`, moves them to `.jdi/archive/removed-<slug>/` instead of deleting (preserves history).

Accepts either a slug (canonical or legacy `NN-slug`) or an integer position. Slug is preferred — it survives roadmap reordering, position does not.
</objective>

<arguments>
- `phase_id` (required) — slug (`auth-flow`) OR position integer (`3`).
- `--force` (optional) — required when removing a phase that has any artifacts in `.jdi/phases/`. Without `--force`, the command refuses and explains.

Examples:
- `/jdi-remove-phase auth-flow`
- `/jdi-remove-phase 4`
- `/jdi-remove-phase payments --force`
</arguments>

<process>

### Step 1: Validation

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y jdi-cli render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).

```bash
test -d .jdi/ || { echo "Not a JDI project."; exit 1; }
test -f .jdi/ROADMAP.md || { echo "ROADMAP.md missing."; exit 1; }

# STATE.md is an untracked advisory cache — regenerate minimal fields if
# absent (fresh clone): current phase = first ROADMAP phase without SHIPPED.md
if [ ! -f .jdi/STATE.md ]; then
  POS=1
  while RESOLVED="$(npx -y jdi-cli resolve-phase "$POS" 2>/dev/null)"; do
    eval "$RESOLVED"
    [ -f "$JDI_PHASE_DIR/SHIPPED.md" ] || break
    POS=$((POS+1))
  done
  printf 'schema_version: 2\ncurrent_phase: %s\ncurrent_phase_slug: %s\n' "$POS" "${JDI_PHASE_SLUG:-}" > .jdi/STATE.md
fi

[ -n "${1:-}" ] || { echo "Phase id required. Usage: /jdi-remove-phase <slug|position> [--force]"; exit 1; }
```

PowerShell mirrors via `Test-Path`. Same `$args` parsing.

### Step 2: Resolve phase

```bash
RESOLVED="$(npx -y jdi-cli resolve-phase "$1")" || {
  echo "Phase '$1' not found in ROADMAP."
  exit 1
}
eval "$RESOLVED"

PHASE_SLUG="$JDI_PHASE_SLUG"
PHASE_DIR="$JDI_PHASE_DIR"
PHASE_POSITION="$JDI_PHASE_POSITION"
PHASE_FOLDER_EXISTS="$JDI_PHASE_FOLDER_EXISTS"
```

PowerShell:
```powershell
$r = npx -y jdi-cli resolve-phase $args[0] --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { Write-Error "Phase '$($args[0])' not found in ROADMAP."; exit $LASTEXITCODE }
$phaseSlug = $r.slug; $phaseDir = $r.dir; $phasePosition = $r.position; $phaseFolderExists = $r.folder_exists
```

### Step 3: Read state + hard refuses

```bash
CURRENT_PHASE_INT=$(grep -oE 'current_phase:\s*[0-9]+' .jdi/STATE.md | grep -oE '[0-9]+' | head -1 || echo "0")
CURRENT_PHASE_SLUG=$(grep -E '^current_phase_slug:' .jdi/STATE.md | sed -E 's/^current_phase_slug:[[:space:]]*//' || true)

# Past phases are history — immutable
if [ "$PHASE_POSITION" -lt "$CURRENT_PHASE_INT" ]; then
  echo "Cannot remove phase '$PHASE_SLUG' (position $PHASE_POSITION) — already past. current_phase is $CURRENT_PHASE_INT. Past phases are immutable history."
  exit 1
fi

# Current phase — must finish or abandon first
if [ "$PHASE_POSITION" -eq "$CURRENT_PHASE_INT" ] || [ "$PHASE_SLUG" = "$CURRENT_PHASE_SLUG" ]; then
  echo "Cannot remove the current phase ('$PHASE_SLUG'). Ship or abandon it first."
  exit 1
fi

# Shipped phases are immutable — status is DERIVED from artifacts:
# SHIPPED.md in the phase folder is the canonical "done" marker (0.2.0+).
if [ -f "$PHASE_DIR/SHIPPED.md" ]; then
  echo "Phase '$PHASE_SLUG' is shipped. Cannot remove. Shipped phases are immutable history."
  exit 1
fi

# Legacy layout (pre-0.2.0 ROADMAPs with per-phase Status lines): honor them.
# (On layout v3 ROADMAP.md is the rendered view — reading it here is fine,
# the render carries no Status lines for v3-born phases.)
STATUS=$(awk -v target="$PHASE_SLUG" '
  /^### Phase / { in_block = 1; matched = 0 }
  in_block && /^- \*\*Slug:\*\*/ {
    s = $0
    sub(/^- \*\*Slug:\*\*[[:space:]]*/, "", s)
    canonical = s; sub(/^[0-9]+-/, "", canonical)
    if (s == target || canonical == target) matched = 1
  }
  matched && /^- \*\*Status:\*\*/ {
    sub(/^- \*\*Status:\*\*[[:space:]]*/, "")
    print
    exit
  }
' .jdi/ROADMAP.md)

if [ "$STATUS" = "done" ]; then
  echo "Phase '$PHASE_SLUG' is 'done'. Cannot remove. Shipped phases are immutable history."
  exit 1
fi
```

### Step 4: Detect artifacts

```bash
if [ "$PHASE_FOLDER_EXISTS" = "true" ] && [ "${FORCE:-false}" != "true" ]; then
  echo "Phase '$PHASE_SLUG' has artifacts in $PHASE_DIR (CONTEXT/PLAN/SUMMARY/REVIEW)."
  echo "Re-run with --force to archive these artifacts to .jdi/archive/removed-$PHASE_SLUG/ and proceed."
  exit 1
fi
```

### Step 5: Confirm with user (irreversible)

AskUserQuestion (always run, even with --force):

> "Remove phase '$PHASE_SLUG' (position $PHASE_POSITION)?
>
> Status: $STATUS
> Artifacts: ${PHASE_DIR if folder_exists else 'none'}
> Action: ROADMAP section removed, total_phases recomputed, artifacts (if any) moved to .jdi/archive/removed-$PHASE_SLUG/."
>
> Options:
> - [Yes, remove]
> - [Cancel]

If Cancel → exit 0 clean.

### Step 6: Archive artifacts (if any)

```bash
if [ "$PHASE_FOLDER_EXISTS" = "true" ]; then
  mkdir -p .jdi/archive

  TARGET=".jdi/archive/removed-$PHASE_SLUG"
  # Disambiguate if a previous removal of the same slug exists
  i=2
  while [ -d "$TARGET" ]; do
    TARGET=".jdi/archive/removed-$PHASE_SLUG-$i"
    i=$((i + 1))
  done

  mv "$PHASE_DIR" "$TARGET"

  # archive/index.md is legacy-only: on layout v3 the archive DIR LISTING is
  # the index (one folder per archived phase — nothing shared to conflict).
  # Append only where the file already exists (legacy projects):
  if [ ! -d .jdi/roadmap ] && [ -f .jdi/archive/index.md ]; then
    echo "- $(basename "$TARGET") (removed $(date -u +%F) via /jdi-remove-phase, original folder: $(basename "$PHASE_DIR"))" >> .jdi/archive/index.md
  fi
fi
```

PowerShell:
```powershell
if ($phaseFolderExists) {
  if (-not (Test-Path .jdi/archive)) { New-Item -ItemType Directory .jdi/archive | Out-Null }
  $target = ".jdi/archive/removed-$phaseSlug"
  $i = 2
  while (Test-Path $target) { $target = ".jdi/archive/removed-$phaseSlug-$i"; $i++ }
  Move-Item $phaseDir $target
  if (-not (Test-Path .jdi/roadmap) -and (Test-Path .jdi/archive/index.md)) {
    Add-Content .jdi/archive/index.md "- $(Split-Path $target -Leaf) (removed $(Get-Date -Format 'yyyy-MM-dd') via /jdi-remove-phase, original folder: $(Split-Path $phaseDir -Leaf))"
  }
}
```

### Step 7: Remove the roadmap entry

**Layout v3** (`.jdi/roadmap/` dir exists): delete the entry file and the
audit decision is a NEW file — no shared file is touched. If another branch
is working on this phase, the merge surfaces a visible modify/delete conflict
on the phase's own files, which is exactly the right signal.

```bash
git rm --quiet ".jdi/roadmap/$PHASE_SLUG.md" 2>/dev/null || rm -f ".jdi/roadmap/$PHASE_SLUG.md"
```

Write `.jdi/decisions/D-{YYYY-MM-DD}-{slug}-rm.md`:

```
D-{YYYY-MM-DD}-{slug}-rm: Phase '{slug}' removed via /jdi-remove-phase. Artifacts: {archived_path or "none"}.
```

Refresh views + commit:

```bash
npx -y jdi-cli render
git add .jdi/roadmap/ .jdi/decisions/
git add .jdi/archive/ 2>/dev/null || true
git commit -m "chore(jdi): remove phase $PHASE_SLUG"
```

**Legacy layout**: remove the entire `### Phase $PHASE_POSITION: ...` block
(header + bullets) up to (but not including) the next `### Phase` line or end
of file. Renumber subsequent `### Phase K` headings to `K-1` (display order;
slug values NEVER change). Recompute `total_phases` only if a legacy line
exists:

```bash
NEW_TOTAL=$(grep -cE '^### Phase ' .jdi/ROADMAP.md)
if grep -qE '^total_phases:' .jdi/ROADMAP.md; then
  sed -i.bak -E "s/^total_phases:.*$/total_phases: $NEW_TOTAL/" .jdi/ROADMAP.md
  rm -f .jdi/ROADMAP.md.bak
fi
```

Append the audit line to `.jdi/DECISIONS.md`
(`D-{YYYY-MM-DD}-{slug}-rm: Phase '{slug}' removed ...`), then:

```bash
git add .jdi/ROADMAP.md .jdi/DECISIONS.md
git add .jdi/archive/ 2>/dev/null || true
git commit -m "chore(jdi): remove phase $PHASE_SLUG"
```

(Legacy merge=union note: if this remove races a merge from another branch
the removed block can reappear — re-run `/jdi-remove-phase {slug}`,
idempotent. This failure mode does not exist on layout v3.)

### Step 10: Confirm

```
Phase '{slug}' removed.
{if artifacts:} Artifacts archived: .jdi/archive/removed-{slug}/
Phases remaining: {NEW_TOTAL}

Note: slugs of remaining phases are not changed. Display positions renumbered.
```

</process>

<gates>
- pre: `.jdi/ROADMAP.md` exists (STATE.md regenerated from artifacts if absent)
- pre: phase resolves via `npx -y jdi-cli resolve-phase`
- pre: phase is not the current phase, not past, status != `done`
- pre: `--force` provided if phase has artifacts
- post: ROADMAP.md section removed + `total_phases` recomputed + artifacts archived (if any) + DECISIONS.md appended + atomic commit
- invariant: slugs of remaining phases never change
</gates>

<errors>
- `.jdi/` missing → "Run /jdi-new first"
- Phase id missing → usage hint
- Phase id not found → resolver exits 2 — propagate
- Phase id is past → refuse (history)
- Phase id is current → refuse (ship or abandon first)
- Status `done` → refuse (shipped = history)
- Artifacts exist + no `--force` → refuse + suggest `--force`
- User cancels → exit clean
</errors>

<runtime_notes>

**Claude Code:**
- Confirms via AskUserQuestion.

**Copilot:**
- AskUserQuestion not always available — require explicit `--yes` flag fallback.

**OpenCode/Antigravity:**
- Same interactive confirm. Fallback to `--yes` when prompts unsupported.

</runtime_notes>
