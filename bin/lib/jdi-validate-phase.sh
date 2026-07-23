#!/usr/bin/env bash
# jdi-validate-phase: mechanical gate over the phase artifact chain.
# Turns the derived-status contract (MEMORY.md) into an executable check —
# same validation for CI gates, delegated-agent protocols and humans.
#
# Usage: jdi-validate-phase.sh <slug|position> [--for-pr] [--quiet]
#
#   default : validates the STRUCTURE of every artifact present (a present
#             but hollow artifact fails); missing artifacts are informative.
#   --for-pr: full-chain gate — all 5 artifacts required AND the REVIEW
#             verdict must be APPROVED or APPROVED_WITH_WARNINGS.
#
# Exit: 0 = pass, 1 = fail (each failing line prints the fix command).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PHASE_ID=""
FOR_PR=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --for-pr) FOR_PR=1 ;;
    --quiet)  QUIET=1 ;;
    -*)       echo "unknown flag: $arg" >&2; exit 1 ;;
    *)        PHASE_ID="$arg" ;;
  esac
done

if [[ -z "$PHASE_ID" ]]; then
  echo "usage: jdi-validate-phase.sh <slug|position> [--for-pr] [--quiet]" >&2
  exit 1
fi

# Invoke via `bash <path>` (not direct exec) so this works regardless of the
# resolver's file mode — consistent with how bin/jdi.js spawns every script,
# and immune to a lost exec bit in the published tarball.
# `set +e` around the call: under `set -e` an assignment whose command
# substitution fails aborts the script immediately, before we can inspect the
# resolver's exit code.
set +e
RESOLVED="$(bash "$SCRIPT_DIR/jdi-resolve-phase.sh" "$PHASE_ID" 2>/dev/null)"
RESOLVE_RC=$?
set -e
if [ "$RESOLVE_RC" -ne 0 ] || [ -z "$RESOLVED" ]; then
  # Distinguish "resolver could not run" from "phase genuinely not found":
  # rc 2 is the resolver's own "not found in ROADMAP" exit; anything else
  # (missing file, non-exec, .jdi absent) is an execution failure.
  if [ "$RESOLVE_RC" -eq 2 ]; then
    echo "[fail] phase '$PHASE_ID' not found in ROADMAP.md"
  else
    echo "[fail] could not run the phase resolver (rc=$RESOLVE_RC) — is this a JDI project with .jdi/ROADMAP.md?"
  fi
  exit 1
fi
eval "$RESOLVED"
SLUG="$JDI_PHASE_SLUG"
DIR="$JDI_PHASE_DIR"

FAILS=0
STATUS="pending"

say() { [[ "$QUIET" -eq 1 ]] || echo "$1"; }

# check <file> <derived-status> <fix-hint> <marker-desc> <grep-args...>
# Present + all markers found -> ok (updates STATUS).
# Present + a marker missing  -> invalid (fail).
# Absent + --for-pr           -> missing (fail); absent otherwise -> info.
check() {
  local file="$1" status_if_ok="$2" fix="$3" marker_desc="$4"
  shift 4
  local path="$DIR/$file"

  if [[ ! -f "$path" ]]; then
    if [[ "$FOR_PR" -eq 1 ]]; then
      say "[missing] $file — required for PR. Fix: $fix"
      FAILS=$((FAILS + 1))
    else
      say "[absent] $file — next: $fix"
    fi
    return 0
  fi

  local m
  for m in "$@"; do
    if ! grep -Eq "$m" "$path"; then
      say "[invalid] $file — expected $marker_desc (missing: $m). Fix: $fix"
      FAILS=$((FAILS + 1))
      return 0
    fi
  done

  say "[ok] $file — $marker_desc"
  STATUS="$status_if_ok"
}

# Ordered per the derived-status ladder (MEMORY.md): each ok advances STATUS.
check "CONTEXT.md" "discussed" "/jdi-discuss $SLUG" \
  "Definition of Done with executable Verify: lines" \
  '^## Definition of Done' 'Verify:'

check "PLAN.md" "planned" "/jdi-plan $SLUG" \
  "tasks with Files modified/Acceptance/Dependencies/Test" \
  '^#### T-' '\*\*Files modified:\*\*' '\*\*Acceptance:\*\*' '\*\*Dependencies:\*\*' '\*\*Test:\*\*'

check "SUMMARY.md" "executed" "/jdi-do $SLUG" \
  "at least one task result line" \
  '^- T-'

check "REVIEW.md" "verified" "/jdi-verify $SLUG" \
  "a verdict line" \
  '(Verdict|Veredicto):\*\* (APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED)'

check "SHIPPED.md" "done" "/jdi-ship $SLUG" \
  "the ship marker with verdict" \
  '^verdict:'

# --for-pr: verdict must release the ship (worst-case across lines, like /jdi-loop).
if [[ "$FOR_PR" -eq 1 && -f "$DIR/REVIEW.md" ]]; then
  VERDICTS=$(grep -oE '(Verdict|Veredicto):\*\* (APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED)' "$DIR/REVIEW.md" | awk '{print $2}' || true)
  if echo "$VERDICTS" | grep -qx 'BLOCKED'; then
    say "[fail] REVIEW.md verdict is BLOCKED — blocked work is never shipped"
    FAILS=$((FAILS + 1))
  elif echo "$VERDICTS" | grep -qx 'APPROVED_PENDING_MANUAL'; then
    say "[fail] REVIEW.md verdict is APPROVED_PENDING_MANUAL — autonomous chains require dod=auto_only (no human to confirm)"
    FAILS=$((FAILS + 1))
  fi
fi

say "derived status: $STATUS (phase $SLUG)"

if [[ "$FAILS" -gt 0 ]]; then
  say "validate-phase: FAIL ($FAILS problem(s))"
  exit 1
fi
say "validate-phase: PASS"
exit 0
