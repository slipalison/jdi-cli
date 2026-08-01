---
name: jdi-confirm-dod
description: Interactive loop to confirm DoD manual items in the phase REVIEW.md. Required when verify returned APPROVED_PENDING_MANUAL. Each item asks user keep/confirm with evidence or remain pending. Accepts slug or position.
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
      - "/jdi-confirm-dod"
      - "confirm DoD manual"
      - "confirm manual definition of done"
---

<objective>
After `/jdi-verify` produces verdict `APPROVED_PENDING_MANUAL`, this command walks every `MANUAL_REQUIRED` item in REVIEW.md and lets the user confirm (with evidence) or leave pending. When all are confirmed, the verdict is upgraded to `APPROVED` and `/jdi-ship` is unblocked.
</objective>

<arguments>
- `phase_id` (required): canonical slug, legacy slug, or integer position
</arguments>

<process>

### Step 1: Validation

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y jdi-cli render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).
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

test -f "$PHASE_DIR/REVIEW.md" || {
  echo "REVIEW.md missing for phase $PHASE_SLUG. Run /jdi-verify $PHASE_SLUG first."
  exit 1
}
```

### Step 3: Read current verdict + count manual items

```bash
# Worst-case across ALL verdict lines (multi-stack REVIEW.md has one per
# reviewer segment). Accepts legacy pt-BR "Veredicto:" files.
VERDICTS=$(grep -oE '(Verdict|Veredicto):\*\* (APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED)' "$PHASE_DIR/REVIEW.md" | awk '{print $2}')

if [ -z "$VERDICTS" ]; then
  echo "No verdict found in $PHASE_DIR/REVIEW.md (corrupt or unrecognized format)."
  echo "Re-run /jdi-verify $PHASE_SLUG."
  exit 1
fi

if echo "$VERDICTS" | grep -qx 'BLOCKED'; then VERDICT=BLOCKED
elif echo "$VERDICTS" | grep -qx 'APPROVED_PENDING_MANUAL'; then VERDICT=APPROVED_PENDING_MANUAL
elif echo "$VERDICTS" | grep -qx 'APPROVED_WITH_WARNINGS'; then VERDICT=APPROVED_WITH_WARNINGS
else VERDICT=APPROVED
fi

# Pending = Manual rows still MANUAL_REQUIRED in the DoD Checklist table
# (the table is the single source of truth; this command flips its rows).
PENDING_COUNT=$(awk '/^## DoD Checklist/,/^## [^D]/' "$PHASE_DIR/REVIEW.md" | grep -cE 'MANUAL_REQUIRED' || true)
PENDING_COUNT="${PENDING_COUNT:-0}"

case "$VERDICT" in
  BLOCKED)
    echo "Phase $PHASE_SLUG is BLOCKED. Fix the failing gates before confirming DoD."
    exit 1
    ;;
  APPROVED|APPROVED_WITH_WARNINGS)
    if [ "$PENDING_COUNT" -eq 0 ]; then
      echo "Phase $PHASE_SLUG already has no pending manual DoD items. Verdict: $VERDICT."
      exit 0
    fi
    ;;
  APPROVED_PENDING_MANUAL)
    : # proceed
    ;;
esac

echo "Phase $PHASE_SLUG: $PENDING_COUNT DoD manual items pending."
```

### Step 4: Extract manual items from DoD Checklist table

Parse the `## DoD Checklist` table in REVIEW.md. Extract each row whose `Status` is `MANUAL_REQUIRED`. Capture: `#`, `Criterion`, `Source`, `Type`, `Evidence` (expected — set by reviewer/asker).

Example bash (table rows look like `| 4 | criterion text | PROJECT | Manual | MANUAL_REQUIRED | — |`):

```bash
# Project-local temp file (portable across bash and PowerShell; removed in Step 9)
awk '
  /^## DoD Checklist/ { flag=1; next }
  /^## / && flag { exit }
  flag && /^\| [0-9]+ .* MANUAL_REQUIRED / {
    print $0
  }
' "$PHASE_DIR/REVIEW.md" > "$PHASE_DIR/.dod-pending.txt"
```

Rows already flipped to `CONFIRMED` or `REJECTED` by a previous run are not
extracted — re-runs resume exactly at the still-pending items.

### Step 5: Per-item confirmation loop

The reviewer may have pre-collected evidence for manual items (Evidence cell
starting with `suggested:` — what it FOUND in the repo, without confirming).
Surface it so confirming is a judgment call, not a scavenger hunt.

For each pending row, run:

```
AskUserQuestion(
  question="DoD manual #{N}: '{criterion text}'\nSource: {source}  | Expected evidence: {evidence_hint}{if suggested: | Reviewer found: {suggested_evidence}}",
  options=[
    {if suggested evidence exists:}
    "Confirm — the reviewer's finding is correct evidence",
    {always:}
    "Confirm — I verified this and will provide evidence",
    "Skip — leave pending (will not ship)",
    "Reject DoD item — waive: criterion not applicable anymore (audited, does not block ship)"
  ]
)
```

- **Confirm (reviewer's finding)** → use the `suggested:` text as the evidence (strip the prefix). Flip Status: `MANUAL_REQUIRED` → `CONFIRMED`.
- **Confirm (own evidence)** → sub-prompt (free text): "Evidence (URL / commit sha / path / short description)?". Then flip the row's Status cell in the DoD Checklist table: `MANUAL_REQUIRED` → `CONFIRMED`. Evidence recorded in Step 6.
- **Skip** → row stays `MANUAL_REQUIRED` (no change). Continue.
- **Reject** → only allowed if user types a justification. Flip the row's Status cell: `MANUAL_REQUIRED` → `REJECTED`. Justification recorded in `## DoD Rejected (post-hoc)` (Step 6). A REJECTED row is an audited waiver — it does not block `/jdi-ship`.

The Status cell flip is what unblocks the ship: `/jdi-ship` counts rows still
`MANUAL_REQUIRED` in this table and refuses while any remain.

Loop until all manual items processed.

### Step 6: Append confirmations section to REVIEW.md

If the section `## DoD Manual Confirmations` already exists (re-run scenario), append new lines. Otherwise create it.

```markdown
## DoD Manual Confirmations

- [x] {criterion text}
      **Confirmed at:** {ISO timestamp UTC}
      **By:** {git config user.name or "unknown"}
      **Evidence:** {user input}
- [ ] {criterion text} (still pending — user skipped)
```

For rejections:

```markdown
## DoD Rejected (post-hoc)

- {criterion text}
      **Rejected at:** {ISO timestamp UTC}
      **Reason:** {user justification}
```

### Step 7: Recompute verdict

All counts come from the DoD Checklist table — the single source of truth
after the Step 5 flips:

```bash
CHECKLIST=$(awk '/^## DoD Checklist/,/^## [^D]/' "$PHASE_DIR/REVIEW.md")
SKIPPED=$(echo "$CHECKLIST" | grep -cE 'MANUAL_REQUIRED' || true)
CONFIRMED=$(echo "$CHECKLIST" | grep -cE '\| *CONFIRMED *\|' || true)
REJECTED=$(echo "$CHECKLIST" | grep -cE '\| *REJECTED *\|' || true)
SKIPPED="${SKIPPED:-0}"; CONFIRMED="${CONFIRMED:-0}"; REJECTED="${REJECTED:-0}"

if [ "$SKIPPED" -gt 0 ]; then
  echo "Phase $PHASE_SLUG: $SKIPPED manual items remain pending. Verdict still APPROVED_PENDING_MANUAL."
  NEW_VERDICT=APPROVED_PENDING_MANUAL
else
  # All resolved (confirmed or rejected). Upgrade verdict.
  # If there were prior warnings, keep WITH_WARNINGS; otherwise full APPROVED.
  WARN_ENTRIES=$(awk '/^## Warnings/,/^## /' "$PHASE_DIR/REVIEW.md" | grep -cE '^- ' || true)
  if [ "${WARN_ENTRIES:-0}" -gt 0 ]; then
    NEW_VERDICT=APPROVED_WITH_WARNINGS
  else
    NEW_VERDICT=APPROVED
  fi
fi

# Upgrade ONLY the verdict lines still holding PENDING_MANUAL. Other segment
# verdicts (multi-stack) keep their own values; the aggregate is recomputed
# worst-case by ship/status from all lines.
sed -i.bak -E "s/^\*\*(Verdict|Veredicto):\*\* APPROVED_PENDING_MANUAL$/\*\*Verdict:\*\* $NEW_VERDICT/" "$PHASE_DIR/REVIEW.md"
rm -f "$PHASE_DIR/REVIEW.md.bak"
```

PowerShell equivalent uses `(Get-Content) -replace ...` + `Set-Content -Encoding utf8 -NoNewline:$false`.

### Step 8: Update STATE.md

```markdown
current_phase: $PHASE_POSITION
current_phase_slug: $PHASE_SLUG
phase_status: {verified|pending_manual_dod}
phase_verdict: {NEW_VERDICT}
next_step: {if APPROVED or WITH_WARNINGS: /jdi-ship $PHASE_SLUG; if PENDING_MANUAL: /jdi-confirm-dod $PHASE_SLUG (skipped items remain)}
```

### Step 9: Commit

```bash
rm -f "$PHASE_DIR/.dod-pending.txt"
git add "$PHASE_DIR/REVIEW.md"; git add .jdi/STATE.md 2>/dev/null || true
git commit -m "docs($PHASE_SLUG): confirm DoD manual items ($CONFIRMED confirmed, $REJECTED rejected, $SKIPPED skipped, verdict $NEW_VERDICT)"
```

### Step 10: Confirm

**All confirmed/rejected (verdict upgraded):**
```
Phase $PHASE_SLUG: $NEW_VERDICT.
Confirmed: $CONFIRMED  Rejected: $REJECTED  Skipped: 0
Next: /jdi-ship $PHASE_SLUG
```

**Some skipped (verdict still PENDING):**
```
Phase $PHASE_SLUG: APPROVED_PENDING_MANUAL ($SKIPPED items still pending).
Confirmed: $CONFIRMED  Rejected: $REJECTED  Skipped: $SKIPPED
Next: /jdi-confirm-dod $PHASE_SLUG (resume skipped items)
```

</process>

<gates>
- pre: REVIEW.md exists + verdict ∈ {APPROVED_PENDING_MANUAL, APPROVED, APPROVED_WITH_WARNINGS with leftover MANUAL_REQUIRED}
- post: REVIEW.md updated with confirmations + verdict recomputed + STATE updated + atomic commit
</gates>

<errors>
- REVIEW.md missing → /jdi-verify
- Verdict BLOCKED → abort (fix gates first)
- No manual items pending → no-op exit 0
- User cancels mid-loop → save partial confirmations (idempotent — re-run resumes)
</errors>

<rules>
- Confirmation always requires evidence (free text). Empty evidence = invalid, ask again.
- Rejection always requires justification. Empty reason = invalid, ask again.
- This command owns EXACTLY ONE kind of table edit: flipping a Manual row's
  Status cell (MANUAL_REQUIRED → CONFIRMED | REJECTED). Rows are never added,
  removed, or otherwise altered; skipped rows stay MANUAL_REQUIRED untouched.
- Evidence/justification sections are append-only — never delete from REVIEW.md.
- Idempotent: re-running extracts only rows still MANUAL_REQUIRED (confirmed
  and rejected rows are not re-offered).
- This command writes to REVIEW.md but NEVER edits DoD source blocks (PROJECT.md, CONTEXT.md). Those remain locked.
</rules>
