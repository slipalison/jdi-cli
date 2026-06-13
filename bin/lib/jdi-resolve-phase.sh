#!/usr/bin/env bash
# jdi-resolve-phase.sh — phase ID resolver
#
# Usage:
#   eval $(jdi-resolve-phase.sh <id>)
#
# Resolves a phase ID (integer position OR slug) into canonical fields.
# Stdout emits KEY=value pairs suitable for `eval` so callers can pull them
# into their own shell environment.
#
# Fields emitted:
#   JDI_PHASE_SLUG=<canonical slug, no NN prefix>
#   JDI_PHASE_DIR=<path to .jdi/phases/<dir>/, may not yet exist>
#   JDI_PHASE_POSITION=<integer position in ROADMAP>
#   JDI_PHASE_SCHEMA=<1|2>
#   JDI_PHASE_FOLDER_EXISTS=<true|false>
#
# Exit codes:
#   0  resolved (folder may or may not exist — check JDI_PHASE_FOLDER_EXISTS)
#   1  invalid input (empty arg, malformed slug, bad integer)
#   2  phase not found in ROADMAP (integer out of range, slug not listed)
#   3  .jdi/ROADMAP.md or .jdi/STATE.md missing
#   4  multiple folder candidates (corrupt repo state)
#
# Multi-developer notes:
# - Resolver is read-only. Safe to run concurrently.
# - Folder existence is informational. Callers decide whether absence
#   is a creation opportunity or an error (e.g. /jdi-discuss expects
#   the folder to be missing or empty; /jdi-do expects PLAN.md present).

set -u

ID="${1:-}"

# --- Input validation ---------------------------------------------------

if [[ -z "$ID" ]]; then
  echo "ERROR: phase ID required (integer position or slug)" >&2
  exit 1
fi

# Slug shape (when input is not pure integer):
#   - lowercase letters, digits, hyphens
#   - starts with a letter
#   - 3..40 chars
# We allow `NN-slug` style as fallback (v1 legacy ID), normalized later.
IS_INTEGER=false
if echo "$ID" | grep -qE '^[0-9]+$'; then
  IS_INTEGER=true
elif ! echo "$ID" | grep -qE '^[a-z0-9][a-z0-9-]{2,49}$'; then
  # Resolver input is permissive: accepts canonical slug (letter-start)
  # AND legacy slug form (digit-prefixed, e.g. "02-auth-flow") for v1 lookups.
  # The validator lib stays strict for NEW slug creation.
  echo "ERROR: invalid phase ID '$ID' (must be integer or slug a-z0-9-, 3-40 chars)" >&2
  exit 1
fi

# --- State files --------------------------------------------------------

if [[ ! -f .jdi/ROADMAP.md ]]; then
  echo "ERROR: .jdi/ROADMAP.md not found (run /jdi-new first)" >&2
  exit 3
fi
if [[ ! -f .jdi/STATE.md ]]; then
  echo "ERROR: .jdi/STATE.md not found (corrupt project)" >&2
  exit 3
fi

# --- Schema detection ---------------------------------------------------

SCHEMA_VERSION=1
SV_LINE=$(grep -oE 'schema_version:[[:space:]]*[0-9]+' .jdi/STATE.md 2>/dev/null | head -1 || true)
if [[ -n "$SV_LINE" ]]; then
  SCHEMA_VERSION=$(echo "$SV_LINE" | grep -oE '[0-9]+' | head -1)
fi

# --- ROADMAP lookup -----------------------------------------------------
# Each phase block in ROADMAP looks like:
#   ### Phase 3: User Authentication
#   - **Slug:** 03-user-auth        (v1)
#   - **Slug:** user-auth           (v2)
# We extract (position, raw_slug) pairs.

if [[ "$IS_INTEGER" == true ]]; then
  # Integer → find phase by position, return its slug
  POSITION="$ID"
  RAW_SLUG=$(awk -v target="$POSITION" '
    /^### Phase / {
      line = $0
      sub(/^### Phase /, "", line)
      sub(/:.*$/, "", line)
      current = line + 0
      next
    }
    current == target && /^- \*\*Slug:\*\*/ {
      sub(/^- \*\*Slug:\*\*[[:space:]]*/, "")
      print
      exit
    }
  ' .jdi/ROADMAP.md)

  if [[ -z "$RAW_SLUG" ]]; then
    echo "ERROR: phase $POSITION not found in ROADMAP" >&2
    exit 2
  fi
else
  # Slug → find phase by slug field, return its position
  # Accept canonical slug ("auth") OR legacy form ("03-auth")
  QUERY="$ID"
  RAW_SLUG="$QUERY"
  POSITION=$(awk -v target="$QUERY" '
    /^### Phase / {
      line = $0
      sub(/^### Phase /, "", line)
      sub(/:.*$/, "", line)
      current = line + 0
      next
    }
    /^- \*\*Slug:\*\*/ {
      raw = $0
      sub(/^- \*\*Slug:\*\*[[:space:]]*/, "", raw)
      canonical = raw
      sub(/^[0-9]+-/, "", canonical)
      if (raw == target || canonical == target) {
        print current
        # capture the raw slug as a side channel via comment to stderr
        # (awk cannot return two values; caller reads RAW_SLUG separately)
        exit
      }
    }
  ' .jdi/ROADMAP.md)

  if [[ -z "$POSITION" ]]; then
    echo "ERROR: slug '$QUERY' not found in ROADMAP" >&2
    exit 2
  fi

  # Re-read RAW_SLUG for the matched position (could be `03-auth` even when user typed `auth`)
  RAW_SLUG=$(awk -v target="$POSITION" '
    /^### Phase / {
      line = $0
      sub(/^### Phase /, "", line)
      sub(/:.*$/, "", line)
      current = line + 0
      next
    }
    current == target && /^- \*\*Slug:\*\*/ {
      sub(/^- \*\*Slug:\*\*[[:space:]]*/, "")
      print
      exit
    }
  ' .jdi/ROADMAP.md)
fi

# --- Canonical slug (strip NN- prefix if v1-style) ---------------------

CANONICAL_SLUG="$RAW_SLUG"
if echo "$CANONICAL_SLUG" | grep -qE '^[0-9]+-'; then
  CANONICAL_SLUG=$(echo "$CANONICAL_SLUG" | sed -E 's/^[0-9]+-//')
fi

# Re-validate slugs sourced from ROADMAP.md (not just the CLI arg). These
# values are emitted as KEY='value' for callers to `eval`, so a tampered
# ROADMAP slug carrying shell metacharacters would otherwise inject. The CLI
# arg is already checked above; the ROADMAP content is not trusted blindly.
for _s in "$RAW_SLUG" "$CANONICAL_SLUG"; do
  if ! echo "$_s" | grep -qE '^[a-z0-9][a-z0-9-]{2,49}$'; then
    echo "ERROR: corrupt slug in ROADMAP.md: '$_s'" >&2
    exit 4
  fi
done

# --- Folder resolution --------------------------------------------------
# Search order (first match wins):
#   1. .jdi/phases/<canonical_slug>/    (v2 layout)
#   2. .jdi/phases/<raw_slug>/          (v1 layout, raw includes NN-)
#   3. .jdi/phases/NN-<canonical_slug>/ (v1 layout reconstructed)
#   4. .jdi/phases/*-<canonical_slug>/  (any NN-prefixed match)

FOLDER=""
NN=$(printf '%02d' "$POSITION")

if [[ -d ".jdi/phases/$CANONICAL_SLUG" ]]; then
  FOLDER=".jdi/phases/$CANONICAL_SLUG"
elif [[ "$RAW_SLUG" != "$CANONICAL_SLUG" ]] && [[ -d ".jdi/phases/$RAW_SLUG" ]]; then
  FOLDER=".jdi/phases/$RAW_SLUG"
elif [[ -d ".jdi/phases/${NN}-${CANONICAL_SLUG}" ]]; then
  FOLDER=".jdi/phases/${NN}-${CANONICAL_SLUG}"
else
  CANDIDATES=$(ls -d ".jdi/phases/"*"-${CANONICAL_SLUG}" 2>/dev/null || true)
  CAND_COUNT=0
  [[ -n "$CANDIDATES" ]] && CAND_COUNT=$(echo "$CANDIDATES" | wc -l | tr -d ' ')
  if [[ "$CAND_COUNT" -eq 1 ]]; then
    FOLDER="$CANDIDATES"
  elif [[ "$CAND_COUNT" -gt 1 ]]; then
    echo "ERROR: multiple folder candidates for slug '$CANONICAL_SLUG': $CANDIDATES" >&2
    exit 4
  fi
fi

FOLDER_EXISTS=true
if [[ -z "$FOLDER" ]]; then
  FOLDER_EXISTS=false
  # Default future folder per schema
  if [[ "$SCHEMA_VERSION" -ge 2 ]]; then
    FOLDER=".jdi/phases/${CANONICAL_SLUG}"
  else
    FOLDER=".jdi/phases/${NN}-${CANONICAL_SLUG}"
  fi
fi

# --- Emit --------------------------------------------------------------

cat <<EOF
JDI_PHASE_SLUG='$CANONICAL_SLUG'
JDI_PHASE_DIR='$FOLDER'
JDI_PHASE_POSITION='$POSITION'
JDI_PHASE_SCHEMA='$SCHEMA_VERSION'
JDI_PHASE_FOLDER_EXISTS='$FOLDER_EXISTS'
EOF

exit 0
