#!/usr/bin/env bash
# jdi-validate-slug.sh — strict phase slug validator
#
# Usage:
#   jdi-validate-slug.sh <slug> [--check-unique]
#
# Validates a candidate slug against JDI naming rules. With --check-unique,
# also asserts the slug is not already taken by an existing phase folder
# OR a ROADMAP entry. This is the multi-developer safeguard: callers MUST
# run it before creating a new phase, and again after `git pull` if the
# elapsed time was non-trivial.
#
# Rules (rejected with named exit code):
#   1  shape       — not [a-z][a-z0-9-]{2,39}
#   2  reserved    — matches a JDI-reserved keyword (current, all, none, archive…)
#   3  duplicate   — folder OR ROADMAP entry already exists with this slug
#                    (only when --check-unique is passed)
#   4  ambiguous   — different folder forms collide (e.g. `01-foo` AND `foo`)
#
# On success: prints the normalized slug to stdout and exits 0.

set -u

SLUG="${1:-}"
CHECK_UNIQUE=false
[[ "${2:-}" == "--check-unique" ]] && CHECK_UNIQUE=true

if [[ -z "$SLUG" ]]; then
  echo "ERROR: slug required" >&2
  exit 1
fi

# --- Rule 1: shape ---
# Lowercase letters/digits/hyphens. Starts with a letter. 3..40 chars total.
# Reject: uppercase, underscores, leading/trailing hyphens, double hyphens.
if ! echo "$SLUG" | grep -qE '^[a-z][a-z0-9-]{2,39}$'; then
  echo "ERROR: slug '$SLUG' invalid shape (need lowercase a-z0-9-, start with letter, 3-40 chars)" >&2
  exit 1
fi
if echo "$SLUG" | grep -qE -- '--'; then
  echo "ERROR: slug '$SLUG' contains double hyphen" >&2
  exit 1
fi
if echo "$SLUG" | grep -qE -- '-$'; then
  echo "ERROR: slug '$SLUG' ends with hyphen" >&2
  exit 1
fi

# --- Rule 2: reserved words ---
RESERVED="current all none archive removed history latest pending ready done blocked partial"
for word in $RESERVED; do
  if [[ "$SLUG" == "$word" ]]; then
    echo "ERROR: slug '$SLUG' is reserved (JDI keyword)" >&2
    exit 2
  fi
done

# --- Rule 3 + 4: uniqueness vs current repo state ---
if [[ "$CHECK_UNIQUE" == true ]]; then
  if [[ ! -d .jdi/phases ]]; then
    # No phases yet — definitely unique
    echo "$SLUG"
    exit 0
  fi

  # Folder collision: any folder whose canonical slug equals $SLUG
  COLLISIONS=""
  for dir in .jdi/phases/*/; do
    [[ -d "$dir" ]] || continue
    name=$(basename "$dir")
    canonical=$(echo "$name" | sed -E 's/^[0-9]+-//')
    if [[ "$canonical" == "$SLUG" ]] || [[ "$name" == "$SLUG" ]]; then
      COLLISIONS="$COLLISIONS $name"
    fi
  done

  COLL_COUNT=$(echo "$COLLISIONS" | tr -s ' ' '\n' | grep -c . || true)
  if [[ "$COLL_COUNT" -ge 2 ]]; then
    echo "ERROR: ambiguous existing folders for slug '$SLUG':$COLLISIONS (repo state corrupt — run /jdi-migrate-phases)" >&2
    exit 4
  fi
  if [[ "$COLL_COUNT" -eq 1 ]]; then
    echo "ERROR: slug '$SLUG' already exists (folder:$COLLISIONS)" >&2
    exit 3
  fi

  # ROADMAP collision: any phase whose Slug field (raw or canonical) equals $SLUG
  if [[ -f .jdi/ROADMAP.md ]] && awk -v target="$SLUG" '
      /^- \*\*Slug:\*\*/ {
        sub(/^- \*\*Slug:\*\*[[:space:]]*/, "")
        raw = $0
        canonical = raw
        sub(/^[0-9]+-/, "", canonical)
        if (raw == target || canonical == target) { found = 1; exit }
      }
      END { exit (found ? 0 : 1) }
    ' .jdi/ROADMAP.md; then
    echo "ERROR: slug '$SLUG' already listed in ROADMAP.md" >&2
    exit 3
  fi
fi

echo "$SLUG"
exit 0
