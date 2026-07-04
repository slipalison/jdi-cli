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
VERDICT=$(grep -oE 'Verdict:\*\* (APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED)' "$PHASE_DIR/REVIEW.md" | awk '{print $2}')

case "$VERDICT" in
  BLOCKED)
    echo "Phase $PHASE_SLUG is BLOCKED. Fix the failing gates before confirming DoD."
    exit 1
    ;;
  APPROVED|APPROVED_WITH_WARNINGS)
    # Check if any manual still requires confirmation (e.g., user re-ran verify with new DoD items)
    PENDING=$(grep -cE 'MANUAL_REQUIRED' "$PHASE_DIR/REVIEW.md" || echo 0)
    if [ "$PENDING" -eq 0 ]; then
      echo "Phase $PHASE_SLUG already has no pending manual DoD items. Verdict: $VERDICT."
      exit 0
    fi
    ;;
  APPROVED_PENDING_MANUAL)
    : # proceed
    ;;
  *)
    echo "Unknown verdict: $VERDICT. Aborting."
    exit 1
    ;;
esac

PENDING_COUNT=$(grep -cE 'MANUAL_REQUIRED' "$PHASE_DIR/REVIEW.md")
echo "Phase $PHASE_SLUG: $PENDING_COUNT DoD manual items pending."
```

### Step 4: Extract manual items from DoD Checklist table

Parse the `## DoD Checklist` table in REVIEW.md. Extract each row whose `Status` is `MANUAL_REQUIRED`. Capture: `#`, `Criterion`, `Source`, `Type`, `Evidence` (expected — set by reviewer/asker).

Example bash (table rows look like `| 4 | criterion text | PROJECT | Manual | MANUAL_REQUIRED | — |`):

```bash
awk '
  /^## DoD Checklist/ { flag=1; next }
  /^## / && flag { exit }
  flag && /^\| [0-9]+ .* MANUAL_REQUIRED / {
    print $0
  }
' "$PHASE_DIR/REVIEW.md" > /tmp/jdi-dod-pending.txt
```

### Step 5: Per-item confirmation loop

For each pending row, run:

```
AskUserQuestion(
  question="DoD manual #{N}: '{criterion text}'\nSource: {source}  | Expected evidence: {evidence_hint}",
  options=[
    "Confirm — I verified this and will provide evidence",
    "Skip — leave pending (will not ship)",
    "Reject DoD item — criterion not applicable anymore (drops the item from DoD)"
  ]
)
```

- **Confirm** → sub-prompt (free text): "Evidence (URL / commit sha / path / short description)?". Persist confirmation.
- **Skip** → mark as still pending (no change). Continue.
- **Reject DoD item** → only allowed if user types a justification. Item is moved to `## DoD Rejected (post-hoc)` section with reason + timestamp. Affects audit trail; reviewer should know if re-run.

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

```bash
PENDING_AFTER=$(grep -cE 'MANUAL_REQUIRED' "$PHASE_DIR/REVIEW.md")
CONFIRMED=$(awk '/^## DoD Manual Confirmations/,/^## /' "$PHASE_DIR/REVIEW.md" | grep -cE '^- \[x\]')
REJECTED=$(awk '/^## DoD Rejected/,/^## /' "$PHASE_DIR/REVIEW.md" | grep -cE '^- ' || echo 0)
SKIPPED=$(awk '/^## DoD Manual Confirmations/,/^## /' "$PHASE_DIR/REVIEW.md" | grep -cE '^- \[ \].*pending')

# All originally pending are either confirmed or rejected?
EXPECTED=$PENDING_AFTER
RESOLVED=$((CONFIRMED + REJECTED))

if [ "$SKIPPED" -gt 0 ]; then
  echo "Phase $PHASE_SLUG: $SKIPPED manual items remain pending. Verdict still APPROVED_PENDING_MANUAL."
  NEW_VERDICT=APPROVED_PENDING_MANUAL
else
  # All resolved (confirmed or rejected). Upgrade verdict.
  # If there were prior warnings, keep WITH_WARNINGS; otherwise full APPROVED.
  HAS_WARN=$(grep -cE '^## Warnings' "$PHASE_DIR/REVIEW.md")
  WARN_ENTRIES=$(awk '/^## Warnings/,/^## /' "$PHASE_DIR/REVIEW.md" | grep -cE '^- ')
  if [ "$HAS_WARN" -gt 0 ] && [ "$WARN_ENTRIES" -gt 0 ]; then
    NEW_VERDICT=APPROVED_WITH_WARNINGS
  else
    NEW_VERDICT=APPROVED
  fi
fi

# Replace the Verdict line in REVIEW.md
sed -i.bak -E "s/^\*\*Verdict:\*\* .*/\*\*Verdict:\*\* $NEW_VERDICT/" "$PHASE_DIR/REVIEW.md"
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
git add "$PHASE_DIR/REVIEW.md" .jdi/STATE.md
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
- Skipped items stay MANUAL_REQUIRED — do not modify them in the DoD Checklist table.
- Confirmations are append-only — never delete from REVIEW.md.
- Idempotent: re-running picks up where last session stopped (skipped items become pending again).
- This command writes to REVIEW.md but NEVER edits DoD source blocks (PROJECT.md, CONTEXT.md). Those remain locked.
</rules>
