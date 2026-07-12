---
name: jdi-add-phase
description: Registers a new phase in ROADMAP.md. Slug-as-ID — multi-developer safe. Validates slug uniqueness and shape. Append at end (default), or position via --before/--after. Atomic commit.
argument_hint: "\"<phase name>\" [--goal \"<goal>\"] [--slug <slug>] [--before <slug>|--after <slug>] [--reason \"<text>\"]"
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
Registers a new phase in the project's roadmap. Edits `.jdi/ROADMAP.md`. Does not start the phase — only registers it. The user advances via `/jdi-discuss <slug>` (or `<position>`) when ready.

Phase identifier is the **slug** (string). Position (`### Phase N`) is purely a display number derived from listing order. Two developers working on different branches may add different phases simultaneously without colliding, because:

1. Slug uniqueness is enforced locally before any write (Step 3)
2. If two devs pick the same slug, git surfaces a conflict on `.jdi/ROADMAP.md` at merge time — no silent collision
3. Folder collisions cannot happen, because folder names match slugs (no shared `02-...` namespace)
</objective>

<arguments>
- `name` (required) — short phase name. Quote if it contains spaces.
- `--goal "<text>"` (optional) — 1-line description of what the phase delivers. AskUserQuestion fills it if missing.
- `--slug <slug>` (optional) — explicit slug override. If omitted, derived from `name`. Must pass strict validation (see Step 3).
- `--before <slug>` (optional) — insert before the phase with this slug.
- `--after <slug>` (optional) — insert after the phase with this slug.
- `--reason "<text>"` (optional) — recorded in `DECISIONS.md` as audit trail when inserting mid-roadmap.

`--before` and `--after` are mutually exclusive. If neither is given, the phase is appended.

Legacy: `--at <N>` (integer position) is accepted on v1 schemas for backwards compatibility. On v2 schemas it is rejected with a hint to use `--before`/`--after` instead, because integer positions are mutable across developer branches.

Examples:
- `/jdi-add-phase "User authentication" --goal "Login + signup + JWT"`
- `/jdi-add-phase "Payments" --slug payments`
- `/jdi-add-phase "Hotfix N+1 query" --after user-auth`
</arguments>

<process>

### Step 1: Validation

```bash
test -d .jdi/ || { echo "Not a JDI project. /jdi-new first."; exit 1; }
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
```

PowerShell mirrors via Test-Path. See `bin/lib/jdi-*.ps1` helpers.

If `name` missing → AskUserQuestion "Phase name?" (free text, required).
If `--goal` missing → AskUserQuestion "Phase goal (1 line)?" (free text, required).

### Step 2: Detect schema version

```bash
SCHEMA=1
SV=$(grep -oE 'schema_version:\s*[0-9]+' .jdi/STATE.md | grep -oE '[0-9]+' | head -1 || true)
[ -n "$SV" ] && SCHEMA=$SV

# Multi-developer safety check — v1 projects should migrate first
if [ "$SCHEMA" -lt 2 ]; then
  echo ""
  echo "WARNING: this project is on schema v1 (numeric phase IDs)."
  echo "If multiple developers run /jdi-add-phase simultaneously, integer"
  echo "positions may collide. Recommended: /jdi-migrate-phases (one-time, non-destructive)."
  echo ""
  # AskUserQuestion: [Continue on v1] / [Run /jdi-migrate-phases first (recommended)] / [Cancel]
fi

# Reject --at on v2
for arg in "$@"; do
  if [ "$SCHEMA" -ge 2 ] && [ "${arg%%=*}" = "--at" ]; then
    echo "ERROR: --at <N> is not supported on schema v2 (numeric positions are mutable across branches)."
    echo "Use --before <slug> or --after <slug> instead."
    exit 1
  fi
done
```

### Step 3: Derive and validate slug (HARD GATE)

```bash
# Derive slug from name if --slug not provided
if [ -z "$SLUG" ]; then
  SLUG=$(echo "$NAME" | tr '[:upper:]' '[:lower:]' \
    | iconv -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-40)
  # Slugs must start with a letter — a digit-leading name ("2FA support")
  # would derive an invalid slug. Prefix instead of failing cryptically.
  case "$SLUG" in
    [0-9]*) SLUG="phase-$SLUG" ;;
  esac
fi

# Strict validation + uniqueness check. Capture the validator's exit code
# IMMEDIATELY — testing "$SLUG" first would overwrite $? with the test's own
# status and the named exit codes (1-4) would never propagate.
SLUG=$(npx -y jdi-cli validate-slug "$SLUG" --check-unique); RC=$?
if [ "$RC" -ne 0 ] || [ -z "$SLUG" ]; then
  # validator already printed the error to stderr
  exit "$RC"
fi
```

PowerShell parallel: `npx -y jdi-cli validate-slug $slug --check-unique`.

**Validation failures (any aborts before any write):**
- Invalid shape (uppercase, underscores, leading hyphen, etc.) → exit 1
- Reserved JDI keyword (`current`, `all`, `archive`, etc.) → exit 2
- Duplicate slug (folder or ROADMAP entry exists) → exit 3
- Corrupt repo (multiple folder forms of the same slug) → exit 4

Validator runs **before** any pull/fetch. Multi-developer collision protection is two-layered:
1. Local pre-check (this step) — catches collisions visible at this moment
2. Git merge — catches collisions that arose on the remote between local check and push

### Step 4: Resolve insert position

Parse ROADMAP.md to count current phases and determine insert index.

```bash
EXISTING=$(grep -cE '^### Phase ' .jdi/ROADMAP.md)
CURRENT_PHASE_INT=$(grep -oE 'current_phase:\s*[0-9]+' .jdi/STATE.md | grep -oE '[0-9]+' | head -1 || echo "0")

if [ -n "$BEFORE_SLUG" ]; then
  # Find position of the anchor phase
  TARGET_POS=$(npx -y jdi-cli resolve-phase "$BEFORE_SLUG" 2>/dev/null | grep '^JDI_PHASE_POSITION=' | cut -d"'" -f2)
  [ -z "$TARGET_POS" ] && { echo "ERROR: anchor slug '$BEFORE_SLUG' not found"; exit 1; }
  INSERT_POS=$TARGET_POS
elif [ -n "$AFTER_SLUG" ]; then
  TARGET_POS=$(npx -y jdi-cli resolve-phase "$AFTER_SLUG" 2>/dev/null | grep '^JDI_PHASE_POSITION=' | cut -d"'" -f2)
  [ -z "$TARGET_POS" ] && { echo "ERROR: anchor slug '$AFTER_SLUG' not found"; exit 1; }
  INSERT_POS=$((TARGET_POS + 1))
else
  INSERT_POS=$((EXISTING + 1))
fi

# Refuse to insert at or before current_phase
if [ "$INSERT_POS" -le "$CURRENT_PHASE_INT" ]; then
  echo "ERROR: cannot insert at position $INSERT_POS — current_phase is $CURRENT_PHASE_INT. Past/current phases are immutable history."
  exit 1
fi
```

### Step 5: Write to ROADMAP.md

**If appending** (`INSERT_POS == EXISTING + 1`): append a new `### Phase N` block at the end of the `## Phases` section.

**If inserting** (`INSERT_POS <= EXISTING`): shift the heading numbers of all subsequent `### Phase K` entries to `### Phase K+1`. **Slug values are NOT changed** — they stay canonical. This is the key v2 invariant: position is display-only, slug is canonical ID.

```markdown
### Phase {INSERT_POS}: {name}
- **Slug:** {slug}              <!-- v2 canonical, no NN prefix -->
- **Goal:** {goal}
```

(No `Status:` line — phase status is derived from the phase folder's
artifacts. Legacy ROADMAPs keep the Status lines on their existing blocks;
new blocks never add one.)

For v1 schema, write `Slug: {NN}-{slug}` instead (preserves legacy folder convention).

### Step 6: Update derived counter

```bash
# total_phases is DERIVED (count of '### Phase ' headings). ROADMAPs created
# on 0.11.0+ do not store it — a stored counter conflicts on every parallel
# add and merges to the WRONG number. Update only if a legacy line exists:
NEW_TOTAL=$(grep -cE '^### Phase ' .jdi/ROADMAP.md)
if grep -qE '^total_phases:' .jdi/ROADMAP.md; then
  sed -i.bak -E "s/^total_phases:.*$/total_phases: $NEW_TOTAL/" .jdi/ROADMAP.md
  rm -f .jdi/ROADMAP.md.bak
fi
```

### Step 7: Audit trail (only if `--reason` provided)

Append to `.jdi/DECISIONS.md` with deterministic ID format (collision-free across branches):

```
D-{YYYY-MM-DD}-{slug}-1: Phase '{name}' (slug: {slug}) added. Reason: {reason}.
```

If multiple decisions share the same date+slug+sequence (e.g. amended on same day), bump the trailing `-1` to `-2`, etc. Scope is per-day-per-slug, so two devs adding different phases on the same day produce non-colliding IDs.

### Step 8: Commit

```bash
git add .jdi/ROADMAP.md .jdi/DECISIONS.md
git commit -m "chore(jdi): add phase $SLUG"
```

Commit scope uses the slug, not the position. Slug is stable across branch merges; position is not.

### Step 9: Confirm

```
Phase {INSERT_POS}: {name}
  Slug:     {slug}
  Goal:     {goal}
  Schema:   v{SCHEMA}

Next: /jdi-discuss {slug}
```

</process>

<gates>
- pre: `.jdi/ROADMAP.md` exists (STATE.md regenerated from artifacts if absent)
- pre: slug passes shape + reserved + uniqueness checks (`npx -y jdi-cli validate-slug --check-unique`)
- pre: `--before`/`--after` anchor resolves successfully if provided
- pre: insert position > current_phase
- pre: `--at` not used on v2 schema
- post: ROADMAP.md gains new phase block + `total_phases` recomputed + atomic commit
- invariant: existing phase slugs are never renamed
</gates>

<errors>
- `.jdi/` missing → "Run /jdi-new first"
- Name empty → AskUserQuestion fills
- Goal empty → AskUserQuestion fills
- Slug fails validation → exit with named code (1: shape, 2: reserved, 3: duplicate, 4: ambiguous)
- `--before` or `--after` anchor not found → exit 1 listing the offending slug
- `--at` on v2 → exit 1 with instruction to use `--before`/`--after`
- Insert position ≤ current_phase → exit 1
- Both `--before` and `--after` given → exit 1 (mutually exclusive)
</errors>

<rules>
- Slug is canonical. Position is display-only.
- Existing phase slugs are NEVER renamed.
- Folder is created later (by `/jdi-discuss`), not here.
- Uniqueness check is local + git-merge layered. Both must hold.
- `--at <N>` is v1-only legacy.
- Audit IDs in DECISIONS.md use `D-{date}-{slug}-{seq}` on v2 (collision-free across branches). v1 keeps `D-N` increment for backwards reading.
</rules>

<runtime_notes>

**Claude Code:**
- AskUserQuestion handles missing args interactively.
- Validator + resolver run via `npx -y jdi-cli` subcommands.

**Copilot:**
- AskUserQuestion not always available — require explicit flags or fail with clear error.

**OpenCode/Antigravity:**
- Same interactive flow as Claude when supported.

</runtime_notes>
