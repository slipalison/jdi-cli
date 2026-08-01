#!/usr/bin/env bash
# jdi-migrate-layout.sh — migrate a legacy .jdi/ to the conflict-free layout (v3).
#
# Usage:
#   jdi-migrate-layout.sh [--dry-run] [--force]
#
# Why: GitHub/GitLab/ADO perform server-side PR merges that IGNORE the
# .gitattributes merge=union driver, so the legacy shared append files
# (ROADMAP.md, DECISIONS.md, todos.md, registry tables) conflict whenever two
# branches touch them — exactly what merge=union was supposed to prevent.
# v3 removes the shared-file class entirely: one entry = one file, single
# writer per file; the old paths become untracked views (jdi-render.sh).
#
# What it does (idempotent — safe to re-run):
#   1. .jdi/ROADMAP.md    -> split into .jdi/roadmap/<slug>.md (+ _header/_footer)
#                            then untracked (git rm --cached) + gitignored
#   2. .jdi/DECISIONS.md  -> git mv .jdi/decisions/LEGACY.md   (frozen)
#   3. .jdi/todos.md      -> git mv .jdi/todos/LEGACY.md       (frozen)
#   4. .jdi/registry.md   -> git mv .jdi/registry/LEGACY.md
#      .jdi/specialists.md    -> .jdi/registry/LEGACY-specialists.md
#      .jdi/reviewers.md      -> .jdi/registry/LEGACY-reviewers.md
#      .jdi/skills-registry.md-> .jdi/registry/LEGACY-skills.md
#   5. .jdi/STATE.md      -> untracked + gitignored (if still tracked)
#   6. .gitignore         -> add the 7 view paths (views are per-clone)
#   7. render the views back at the old paths (readers keep their paths)
#   8. git add everything (staged, NOT committed — review then commit)
#
# LEGACY files are frozen history: nothing ever appends to them again. New
# entries go to the per-entry dirs. .jdi/archive/index.md stays in place but
# gains no new lines (writers stop; the archive dir listing is the index).
#
# Requirements: run at the repo root of a git repo with a .jdi/ folder.
# Working tree changes under .jdi/ must be committed first (or use --force).
#
# Exit: 0 migrated (or already v3), 1 precondition failed, 2 usage error.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --force)   FORCE=1 ;;
    *) echo "usage: jdi-migrate-layout.sh [--dry-run] [--force]" >&2; exit 2 ;;
  esac
done

fail() { echo "ERROR: $1" >&2; exit 1; }
act()  { echo "  $1"; }

[[ -d .jdi ]] || fail "no .jdi/ here — run from the project root of a JDI project"
git rev-parse --git-dir >/dev/null 2>&1 || fail "not a git repository — v3 migration rewires git tracking"

# Already v3? Re-running is a render refresh, not an error.
if [[ -d .jdi/roadmap ]]; then
  echo "layout v3 already present (.jdi/roadmap/ exists)"
  if [[ "$DRY" -eq 0 ]]; then
    bash "$SCRIPT_DIR/jdi-render.sh" --quiet
    echo "views refreshed. Nothing to migrate."
  fi
  exit 0
fi

# Dirty .jdi/ tree makes the git mv/rm surgery ambiguous.
if [[ "$FORCE" -eq 0 ]] && ! git diff --quiet -- .jdi 2>/dev/null; then
  fail "uncommitted changes under .jdi/ — commit them first (or --force)"
fi

echo "migrate-layout: legacy shared files -> conflict-free per-entry layout (v3)"
[[ "$DRY" -eq 1 ]] && echo "(dry-run — no changes)"

# Track helpers as no-ops in dry-run.
run() { if [[ "$DRY" -eq 1 ]]; then act "would: $*"; else "$@"; fi; }

ignore_add() {
  local pattern="$1"
  if grep -qxF "$pattern" .gitignore 2>/dev/null; then return 0; fi
  if [[ "$DRY" -eq 1 ]]; then act "would: gitignore $pattern"; else echo "$pattern" >> .gitignore; fi
}

# git mv that tolerates untracked sources (mv + add) and is a no-op when the
# source is already gone.
move_frozen() {
  local src="$1" dst="$2"
  [[ -f "$src" ]] || return 0
  act "freeze $src -> $dst"
  if [[ "$DRY" -eq 1 ]]; then return 0; fi
  mkdir -p "$(dirname "$dst")"
  if git ls-files --error-unmatch "$src" >/dev/null 2>&1; then
    git mv -f "$src" "$dst"
  else
    mv -f "$src" "$dst"
  fi
}

# --- 1. ROADMAP.md -> .jdi/roadmap/<slug>.md ------------------------------

[[ -f .jdi/ROADMAP.md ]] || fail ".jdi/ROADMAP.md not found — nothing to split (corrupt project?)"

SPLIT_DIR="$(mktemp -d)"
trap 'rm -rf "$SPLIT_DIR"' EXIT

# Split: preamble (before first '### Phase') -> _header.md; each phase block
# (heading until next '### Phase' or '## ' section) -> NNN-<n>.part with the
# order recorded; everything after the last phase block -> _footer.md.
awk -v out="$SPLIT_DIR" '
  function flush() {
    if (state == "phase") close(out "/" sprintf("%03d", idx) ".part")
  }
  { sub(/\r$/, "") }
  /^### Phase [0-9]+:/ {
    flush()
    state = "phase"; idx++
    order = $0; sub(/^### Phase /, "", order); sub(/:.*$/, "", order)
    name = $0; sub(/^### Phase [0-9]+:[[:space:]]*/, "", name)
    file = out "/" sprintf("%03d", idx) ".part"
    print order > (file ".order")
    print name  > (file ".name")
    next
  }
  state == "phase" && /^## / { flush(); state = "footer" }
  state == ""       { print > (out "/_header.md"); next }
  state == "phase"  { print > (out "/" sprintf("%03d", idx) ".part"); next }
  state == "footer" { print > (out "/_footer.md"); next }
' .jdi/ROADMAP.md

PHASE_COUNT=$(ls "$SPLIT_DIR"/*.part 2>/dev/null | wc -l | tr -d ' ')
[[ "$PHASE_COUNT" -gt 0 ]] || fail "no '### Phase N:' blocks found in ROADMAP.md — cannot split"

act "split ROADMAP.md into $PHASE_COUNT phase file(s) under .jdi/roadmap/"
if [[ "$DRY" -eq 0 ]]; then
  mkdir -p .jdi/roadmap
  for part in "$SPLIT_DIR"/*.part; do
    ORDER="$(tr -d '[:space:]' < "$part.order")"
    NAME="$(head -n 1 "$part.name")"
    RAW_SLUG="$(grep -m1 -E '^- \*\*Slug:\*\*' "$part" | sed -E 's/^- \*\*Slug:\*\*[[:space:]]*//' | tr -d '\r' || true)"
    [[ -n "$RAW_SLUG" ]] || fail "phase '$NAME' has no '- **Slug:**' line — fix ROADMAP.md first"
    SLUG="$(echo "$RAW_SLUG" | sed -E 's/^[0-9]+-//')"
    echo "$SLUG" | grep -qE '^[a-z0-9][a-z0-9-]{2,49}$' || fail "phase '$NAME' has invalid slug '$RAW_SLUG'"
    [[ -f ".jdi/roadmap/$SLUG.md" ]] && fail "duplicate slug '$SLUG' in ROADMAP.md — fix before migrating"
    {
      echo "---"
      echo "order: $ORDER"
      echo "name: $NAME"
      echo "---"
      # body: canonicalize the Slug line (strip NN- prefix), keep the rest,
      # trim trailing blank lines
      awk -v slug="$SLUG" '
        /^- \*\*Slug:\*\*/ { print "- **Slug:** " slug; next }
        { lines[++n] = $0 }
        END {
          end = n
          while (end >= 1 && lines[end] == "") end--
          for (i = 1; i <= end; i++) print lines[i]
        }
      ' "$part"
    } > ".jdi/roadmap/$SLUG.md"
  done
  if [[ -s "$SPLIT_DIR/_header.md" ]]; then
    awk '{ lines[++n] = $0 } END { end = n; while (end >= 1 && lines[end] == "") end--; for (i = 1; i <= end; i++) print lines[i] }' \
      "$SPLIT_DIR/_header.md" > .jdi/roadmap/_header.md
  fi
  if [[ -s "$SPLIT_DIR/_footer.md" ]]; then
    awk '{ lines[++n] = $0 } END { end = n; while (end >= 1 && lines[end] == "") end--; for (i = 1; i <= end; i++) print lines[i] }' \
      "$SPLIT_DIR/_footer.md" > .jdi/roadmap/_footer.md
  fi
fi

act "untrack .jdi/ROADMAP.md (becomes a rendered view)"
if [[ "$DRY" -eq 0 ]]; then
  git rm --cached --quiet .jdi/ROADMAP.md 2>/dev/null || true
  rm -f .jdi/ROADMAP.md
fi
ignore_add ".jdi/ROADMAP.md"

# --- 2-4. freeze the append streams ---------------------------------------

run mkdir -p .jdi/decisions .jdi/todos .jdi/registry
move_frozen .jdi/DECISIONS.md        .jdi/decisions/LEGACY.md
move_frozen .jdi/todos.md            .jdi/todos/LEGACY.md
move_frozen .jdi/registry.md         .jdi/registry/LEGACY.md
move_frozen .jdi/specialists.md      .jdi/registry/LEGACY-specialists.md
move_frozen .jdi/reviewers.md        .jdi/registry/LEGACY-reviewers.md
move_frozen .jdi/skills-registry.md  .jdi/registry/LEGACY-skills.md

ignore_add ".jdi/DECISIONS.md"
ignore_add ".jdi/todos.md"
ignore_add ".jdi/registry.md"
ignore_add ".jdi/specialists.md"
ignore_add ".jdi/reviewers.md"
ignore_add ".jdi/skills-registry.md"

# Keep the dirs alive in git even while empty.
if [[ "$DRY" -eq 0 ]]; then
  for d in .jdi/roadmap .jdi/decisions .jdi/todos .jdi/registry; do
    [[ -n "$(ls -A "$d" 2>/dev/null)" ]] || touch "$d/.gitkeep"
  done
fi

# --- 5. STATE.md (fold in the 0.3.0 migration for old projects) -----------

if git ls-files --error-unmatch .jdi/STATE.md >/dev/null 2>&1; then
  act "untrack .jdi/STATE.md (per-clone advisory cache)"
  [[ "$DRY" -eq 0 ]] && git rm --cached --quiet .jdi/STATE.md
fi
ignore_add ".jdi/STATE.md"

# --- 7. render views at the old paths -------------------------------------

if [[ "$DRY" -eq 0 ]]; then
  bash "$SCRIPT_DIR/jdi-render.sh" --quiet
  act "views rendered (untracked): ROADMAP.md DECISIONS.md todos.md registry.md specialists.md reviewers.md skills-registry.md"
fi

# --- 8. stage -------------------------------------------------------------

if [[ "$DRY" -eq 0 ]]; then
  git add .jdi/ .gitignore
  echo ""
  echo "migrate-layout: DONE (staged, not committed)."
  echo "Review with: git status .jdi/"
  echo 'Commit with:  git commit -m "chore(jdi): migrate .jdi/ to conflict-free layout (v3)"'
  echo ""
  echo "Merge note: branches created BEFORE this migration still edit the old"
  echo "tracked paths and will hit ONE visible delete/modify conflict when"
  echo "merged — rebase them (or re-run their JDI step) after this lands on"
  echo "the default branch. New branches are conflict-free by construction."
else
  echo ""
  echo "migrate-layout: dry-run complete. Re-run without --dry-run to apply."
fi
exit 0
