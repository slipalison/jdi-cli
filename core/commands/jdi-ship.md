---
name: jdi-ship
description: Finalizes phase after verify. Updates ROADMAP.md, marks phase as done, advances pointer to next. Accepts slug or position.
argument_hint: "<slug|position>"
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
      - "/jdi-ship"
      - "finalize phase"
---

<objective>
Finalizes phase after /jdi-verify approves. Updates ROADMAP.md (phase: done), advances STATE to next phase, final commit.
</objective>

<arguments>
- `phase_id` (required): canonical slug, legacy slug, or integer position
</arguments>

<process>

### Step 1: Validation
```bash
test -d .jdi/ || { echo "Not a JDI project."; exit 1; }
```

### Step 2: Resolve phase

```bash
RESOLVED="$(npx -y jdi-cli resolve-phase "$1")" || { echo "Phase '$1' not found."; exit 1; }
eval "$RESOLVED"
PHASE_SLUG="$JDI_PHASE_SLUG"
PHASE_DIR="$JDI_PHASE_DIR"
PHASE_POSITION="$JDI_PHASE_POSITION"

# Idempotency: refuse double-ship (SHIPPED.md is the per-phase marker)
if [ -f "$PHASE_DIR/SHIPPED.md" ]; then
  echo "Phase $PHASE_SLUG already shipped ($(head -1 "$PHASE_DIR/SHIPPED.md" 2>/dev/null))."
  exit 0
fi

# Verify REVIEW.md exists
test -f "$PHASE_DIR/REVIEW.md" || {
  echo "REVIEW.md missing. /jdi-verify $PHASE_SLUG."
  exit 1
}

# Read verdict — worst-case across ALL verdict lines (multi-stack REVIEW.md
# has one per reviewer segment). Accepts legacy pt-BR "Veredicto:" files.
VERDICTS=$(grep -oE '(Verdict|Veredicto):\*\* (APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED)' "$PHASE_DIR/REVIEW.md" | awk '{print $2}')

if [ -z "$VERDICTS" ]; then
  echo "No verdict found in $PHASE_DIR/REVIEW.md (corrupt or unrecognized format)."
  echo "Ship refused. Re-run /jdi-verify $PHASE_SLUG."
  exit 1
fi

if echo "$VERDICTS" | grep -qx 'BLOCKED'; then VERDICT=BLOCKED
elif echo "$VERDICTS" | grep -qx 'APPROVED_PENDING_MANUAL'; then VERDICT=APPROVED_PENDING_MANUAL
elif echo "$VERDICTS" | grep -qx 'APPROVED_WITH_WARNINGS'; then VERDICT=APPROVED_WITH_WARNINGS
else VERDICT=APPROVED
fi

if [ "$VERDICT" = "BLOCKED" ]; then
  echo "Phase $PHASE_SLUG BLOCKED. Fix before ship."
  exit 1
fi

if [ "$VERDICT" = "APPROVED_PENDING_MANUAL" ]; then
  PENDING=$(awk '/^## DoD Checklist/,/^## [^D]/' "$PHASE_DIR/REVIEW.md" | grep -cE 'MANUAL_REQUIRED' || true)
  cat <<MSG
Phase $PHASE_SLUG: APPROVED_PENDING_MANUAL (${PENDING:-?} DoD manual items pending).
Ship refused — manual DoD items must be confirmed first.

Next: /jdi-confirm-dod $PHASE_SLUG
MSG
  exit 1
fi
```

### Step 2.5: Re-verify DoD confirmation freshness

The DoD Checklist table in REVIEW.md is the single source of truth:
`/jdi-confirm-dod` flips each Manual row's Status from `MANUAL_REQUIRED` to
`CONFIRMED` (satisfied, with evidence) or `REJECTED` (waived — criterion no
longer applicable, with justification). Ship only requires that no row is
still `MANUAL_REQUIRED`:

```bash
STILL_PENDING=$(awk '/^## DoD Checklist/,/^## [^D]/' "$PHASE_DIR/REVIEW.md" | grep -cE 'MANUAL_REQUIRED' || true)

if [ "${STILL_PENDING:-0}" -gt 0 ]; then
  echo "Phase $PHASE_SLUG: $STILL_PENDING manual DoD item(s) still unconfirmed."
  echo "Next: /jdi-confirm-dod $PHASE_SLUG"
  exit 1
fi
```

(`REJECTED` rows do not block the ship — they are audited waivers, visible in
the table and in the `## DoD Rejected (post-hoc)` section.)

### Step 3: Confirm with user (only if WITH_WARNINGS)

If `VERDICT=APPROVED_WITH_WARNINGS`:
```
Phase $PHASE_SLUG has uncorrected warnings. Ship anyway?
- Yes, ship (warnings remain in REVIEW.md)
- No, fix first
```

If "No" → exit clean.

### Step 4: Update ROADMAP.md

Find the phase by `Slug:` value (canonical or legacy form). Edit:
- This phase: `status: done`
- Next phase (if any): `status: ready`

```bash
# Use awk to update only the phase block matching $PHASE_SLUG
NEXT_POSITION=$((PHASE_POSITION + 1))
```

If no phase at NEXT_POSITION:
```
All phases complete.
Project delivered.
```

### Step 5: Resolve next phase slug

```bash
NEXT_PHASE_SLUG=""
if RESOLVED="$(npx -y jdi-cli resolve-phase "$NEXT_POSITION" 2>/dev/null)"; then
  eval "$RESOLVED"
  NEXT_PHASE_SLUG="$JDI_PHASE_SLUG"
fi
```

### Step 6: Update STATE.md

```markdown
current_phase: {NEXT_POSITION or done}
current_phase_slug: {NEXT_PHASE_SLUG or done}
phase_status: ready (if next exists) or complete
next_step: /jdi-discuss {NEXT_PHASE_SLUG} or done
```

### Step 7: Archive old phases (compaction)

Read `archive_after` from `.jdi/config.json` (default 5). Phases with position `<= NEXT_POSITION - archive_after` move to `.jdi/archive/`.

```bash
ARCHIVE_AFTER=5
if [ -f .jdi/config.json ] && command -v jq >/dev/null 2>&1; then
  ARCHIVE_AFTER=$(jq -r '.compaction.archive_after // 5' .jdi/config.json)
fi

THRESHOLD=$((NEXT_POSITION - ARCHIVE_AFTER))

if [ "$THRESHOLD" -ge 1 ]; then
  mkdir -p .jdi/archive
  test -f .jdi/archive/index.md || echo "# Archive index" > .jdi/archive/index.md

  # Walk ROADMAP phases by position, archive folders whose position <= THRESHOLD
  awk '
    /^### Phase / {
      line = $0
      sub(/^### Phase /, "", line)
      pos = line + 0
      next
    }
    /^- \*\*Slug:\*\*/ {
      slug = $0
      sub(/^- \*\*Slug:\*\*[[:space:]]*/, "", slug)
      print pos "|" slug
    }
  ' .jdi/ROADMAP.md | while IFS='|' read -r pos raw_slug; do
    [ "$pos" -le "$THRESHOLD" ] || continue
    RESOLVED="$(npx -y jdi-cli resolve-phase "$pos" 2>/dev/null)" || continue
    eval "$RESOLVED"
    [ "$JDI_PHASE_FOLDER_EXISTS" = "true" ] || continue

    VERDICT_OLD=$(grep -oE 'Verdict:\*\* (APPROVED|APPROVED_WITH_WARNINGS|BLOCKED)' "$JDI_PHASE_DIR/REVIEW.md" 2>/dev/null | awk '{print $2}' || echo "UNKNOWN")
    mv "$JDI_PHASE_DIR" .jdi/archive/
    echo "- $(basename "$JDI_PHASE_DIR"): $VERDICT_OLD (archived $(date -u +%F))" >> .jdi/archive/index.md
  done
fi
```

PowerShell equivalent uses `Move-Item` + `Add-Content` + the resolver `.ps1`. See `bin/lib/` mirror.

Archived phases remain accessible via `.jdi/archive/` but exit the default read-path.

### Step 8: Refresh manifest (v2 only)

If `.jdi/phases.json` exists, regenerate from updated ROADMAP.

### Step 9: Final commit

```bash
git add .jdi/ROADMAP.md .jdi/STATE.md .jdi/archive/ .jdi/phases.json 2>/dev/null
git commit -m "feat($PHASE_SLUG): ship phase ($VERDICT)"
```

Optional tag (if PROJECT.md has `tag_phases: true`):
```bash
git tag "phase-$PHASE_SLUG"
```

### Step 10: Confirm

```
Phase $PHASE_SLUG shipped.
{if more phases:} Next: /jdi-discuss $NEXT_PHASE_SLUG
{if last:} Project delivered. Tag: phase-$PHASE_SLUG
```

</process>

<gates>
- pre: REVIEW.md exists + verdict ∉ {BLOCKED, APPROVED_PENDING_MANUAL} + all DoD manual items confirmed
- post: ROADMAP.md + STATE.md updated + old phases archived (if applicable) + commit (+ optional tag)
</gates>

<errors>
- REVIEW missing → /jdi-verify
- Verdict BLOCKED → abort
- Verdict APPROVED_PENDING_MANUAL → abort, suggest /jdi-confirm-dod
- Manual DoD items unconfirmed (count mismatch) → abort, suggest /jdi-confirm-dod
- Already shipped → abort with warning
</errors>
