---
name: jdi-ship
description: Finalizes phase after verify. Writes the SHIPPED.md marker in the phase folder, advances STATE hint to next phase. ROADMAP.md untouched (conflict-free for teams). --pr opens a pull request via gh (best-effort). Accepts slug or position.
argument_hint: "<slug|position> [--pr]"
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
Finalizes phase after /jdi-verify approves. Writes phases/<slug>/SHIPPED.md (the derived-status "done" marker), advances the STATE hint to the next phase, final commit. ROADMAP.md is not edited — parallel developers shipping different phases never conflict.
</objective>

<arguments>
- `phase_id` (required): canonical slug, legacy slug, or integer position
- `--pr` (optional): after the final commit, open a pull request via `gh`
  (best-effort — never fails the ship). Fits the team flow "one phase per
  branch": the artifact ends up where it belongs, in the system of record.
</arguments>

<process>

### Step 1: Validation

**View refresh (layout v3):** if `.jdi/roadmap/` exists, run `npx -y jdi-cli@0.17.0 render` FIRST — it regenerates the untracked views (ROADMAP.md, DECISIONS.md, todos.md, registry tables) from the per-entry dirs, so every read below sees current state. No-op on legacy projects (and never overwrites a legacy tracked file).
```bash
test -d .jdi/ || { echo "Not a JDI project."; exit 1; }

WITH_PR=false
for a in "$@"; do [ "$a" = "--pr" ] && WITH_PR=true; done
```

### Step 2: Resolve phase and read the verdict (mechanically)

```bash
RESOLVED="$(npx -y jdi-cli@0.17.0 resolve-phase "$1")" || { echo "Phase '$1' not found."; exit 1; }
eval "$RESOLVED"
PHASE_SLUG="$JDI_PHASE_SLUG"
PHASE_DIR="$JDI_PHASE_DIR"

# Idempotency: SHIPPED.md is the per-phase marker
[ -f "$PHASE_DIR/SHIPPED.md" ] && { echo "Phase $PHASE_SLUG already shipped."; exit 0; }

# Worst case across all REVIEW.md segments; exit 2 = no verdict (never ship on silence)
VERDICT=$(npx -y jdi-cli@0.17.0 review verdict "$PHASE_SLUG") || { echo "No verdict in $PHASE_DIR/REVIEW.md — re-run /jdi-verify $PHASE_SLUG."; exit 1; }
case "$VERDICT" in
  BLOCKED) echo "Phase $PHASE_SLUG BLOCKED. Fix before ship."; exit 1 ;;
  APPROVED_PENDING_MANUAL) echo "Manual DoD items pending. Next: /jdi-confirm-dod $PHASE_SLUG"; exit 1 ;;
esac
```

(`jdi-cli ship` in Step 5 re-checks all of this and also refuses any DoD
Checklist row still `MANUAL_REQUIRED`; `REJECTED` rows are audited waivers and
do not block.)

### Step 3: Confirm with user (only if WITH_WARNINGS)

If `VERDICT=APPROVED_WITH_WARNINGS`:
```
Phase $PHASE_SLUG has uncorrected warnings. Ship anyway?
- Yes, ship (warnings remain in REVIEW.md)
- No, fix first
```

If "No" → exit clean. (Autonomous `/jdi-issue` never asks: it already ran its
warnings round.)

### Step 4: Distill learnings (the only step that needs judgment)

Input: the work list, not the whole review —
`npx -y jdi-cli@0.17.0 review blockers "$PHASE_SLUG"` (blockers + warnings) and
the `## Blocked tasks` of `$PHASE_DIR/SUMMARY.md`. Write at most **5
one-line bullets** — only what could recur in FUTURE phases (recurring
pitfalls, waived criteria, systemic warnings) — to
`.jdi/cache/learnings-$PHASE_SLUG.md`. Nothing qualifies → skip the file.

- Imperative and self-contained (readable without REVIEW.md); never pasted gate output.
- Read by the next phases through `jdi-cli learnings --last 3` (briefs of the
  planner and the doer), where they become acceptance criteria.
- A learning that cost a whole loop round and can recur in any phase also
  becomes a known-errors entry (`.jdi/known-errors/<ID>.md`, with `stage`,
  `globs` and `mechanized_by` when a gate already blocks it).

### Step 5: Ship (deterministic)

```bash
LEARN_ARG=""; [ -f ".jdi/cache/learnings-$PHASE_SLUG.md" ] && LEARN_ARG="--learnings-file .jdi/cache/learnings-$PHASE_SLUG.md"
SHIP=$(npx -y jdi-cli@0.17.0 ship "$PHASE_SLUG" $LEARN_ARG) || { echo "Ship refused: $SHIP"; exit 1; }
```

`SHIP` is JSON: writes `$PHASE_DIR/SHIPPED.md` (`shipped_at`, `verdict`, `by`,
`## Learnings`), refreshes the advisory STATE.md for the next phase, and runs
the archive compaction (`compaction.archive_after`, `0` = off; moved folders in
`archived`). Phase completion is recorded IN THE PHASE FOLDER, never in
ROADMAP.md — parallel developers shipping different phases never conflict.

### Step 6: Final commit

```bash
git add "$PHASE_DIR/SHIPPED.md" .jdi/known-errors/ 2>/dev/null
git add -A .jdi/phases .jdi/archive 2>/dev/null || true   # archive moves (if any)
git add .jdi/STATE.md 2>/dev/null || true                 # legacy projects that still track it
git commit -m "feat($PHASE_SLUG): ship phase ($VERDICT)"
```

Optional tag (if PROJECT.md has `tag_phases: true`):
```bash
git tag "phase-$PHASE_SLUG"
```

### Step 6.5: Open pull request (only with `--pr`)

Best-effort — a failed PR never fails the ship (SHIPPED.md is already the
source of truth). Requires: `gh` CLI, a remote, and a non-default branch.

```bash
if [ "$WITH_PR" = true ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "note: gh CLI not found — skipping PR. Install: cli.github.com"
  elif ! git remote get-url origin >/dev/null 2>&1; then
    echo "note: no git remote — skipping PR."
  else
    DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo main)
    CURRENT_BRANCH=$(git branch --show-current)
    if [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ]; then
      echo "note: on default branch ($DEFAULT_BRANCH) — skipping PR. Team flow: one phase per branch."
    else
      git push -u origin "$CURRENT_BRANCH" || { echo "note: push failed — skipping PR."; }
      LEARNINGS=$(sed -n '/^## Learnings/,$p' "$PHASE_DIR/SHIPPED.md" 2>/dev/null)
      gh pr create \
        --title "feat($PHASE_SLUG): ship phase ($VERDICT)" \
        --body "Phase \`$PHASE_SLUG\` shipped via JDI.

**Verdict:** $VERDICT
**Review:** \`$PHASE_DIR/REVIEW.md\` (gates + DoD checklist in the diff)
**Summary:** \`$PHASE_DIR/SUMMARY.md\`

$LEARNINGS" \
        && echo "PR opened." || echo "note: gh pr create failed — open manually."
    fi
  fi
fi
```

PowerShell mirrors with `Get-Command gh` + the same `gh` calls.

### Step 7: Confirm

```
Phase $PHASE_SLUG shipped.
{if more phases:} Next: start a NEW session (/clear), then /jdi-discuss $NEXT_PHASE_SLUG
{if last:} Project delivered. Tag: phase-$PHASE_SLUG
```

A shipped phase is the end of this orchestration session: everything the next
phase needs is in `.jdi/`, and carrying this session's context into the next
phase makes every later turn re-read it.

</process>

<gates>
- pre: REVIEW.md exists + verdict ∉ {BLOCKED, APPROVED_PENDING_MANUAL} + no DoD row still MANUAL_REQUIRED + SHIPPED.md absent
- post: SHIPPED.md written + STATE.md updated + old phases archived (if applicable) + commit (+ optional tag) (+ PR when --pr and gh/remote/branch allow — best-effort, never blocks). ROADMAP.md untouched except legacy Status-line projects.
</gates>

<errors>
- REVIEW missing → /jdi-verify
- Verdict BLOCKED → abort
- Verdict APPROVED_PENDING_MANUAL → abort, suggest /jdi-confirm-dod
- Manual DoD items unconfirmed (count mismatch) → abort, suggest /jdi-confirm-dod
- Already shipped → abort with warning
</errors>
