#!/usr/bin/env bash
# jdi-install-caveman (POSIX): clones caveman plugin into Claude Code plugins dir.
#
# Optional install. Default repo: https://github.com/JuliusBrussee/caveman
# Idempotent: if target dir exists, asks overwrite/keep/cancel.
#
# Usage:
#   ./bin/jdi-install-caveman.sh
#   ./bin/jdi-install-caveman.sh --scope project
#   ./bin/jdi-install-caveman.sh --repo https://github.com/forked/caveman.git --force
#
# Flags:
#   --repo <url>    Git URL (default: https://github.com/JuliusBrussee/caveman.git)
#   --scope <s>     user (default) -> ~/.claude/plugins/caveman/
#                   project        -> ./.claude/plugins/caveman/
#   --force         Overwrite existing install without prompt

set -euo pipefail

REPO='https://github.com/JuliusBrussee/caveman.git'
SCOPE=user
FORCE=0
PROJECT_DIR="$(pwd)"
USER_HOME="${HOME:-$USERPROFILE}"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)  REPO="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

case "$SCOPE" in
  user|project) ;;
  *) echo "Invalid --scope. Use: user | project"; exit 1 ;;
esac

if [ "$SCOPE" = "user" ]; then
  BASE_DIR="$USER_HOME/.claude/plugins"
else
  BASE_DIR="$PROJECT_DIR/.claude/plugins"
fi
TARGET="$BASE_DIR/caveman"

echo ""
echo "=== JDI: Install Caveman plugin ==="
echo ""
echo "  Repo:   $REPO"
echo "  Scope:  $SCOPE"
echo "  Target: $TARGET"
echo ""

if ! command -v git >/dev/null 2>&1; then
  echo "git not in PATH. Install git and retry."
  exit 1
fi

if [ -d "$TARGET" ]; then
  if [ "$FORCE" != "1" ]; then
    echo "  Target exists."
    read -p "  Overwrite? (y/N) " ans
    case "$ans" in
      [yY]*) ;;
      *) echo "  Skipped."; exit 0 ;;
    esac
  fi
  echo "  Removing old install..."
  rm -rf "$TARGET"
fi

mkdir -p "$BASE_DIR"

echo "  Cloning..."
case "$REPO" in
  https://*|git@*) : ;;
  *) echo "Repo invalido (esperado https:// ou git@): $REPO" >&2; exit 1 ;;
esac
git clone --depth 1 -- "$REPO" "$TARGET" 2>&1 | sed 's/^/    /'

if [ $? -ne 0 ]; then
  echo "git clone failed."
  exit 1
fi

# Verify plugin shape
if [ -f "$TARGET/plugin.json" ] || [ -d "$TARGET/.claude-plugin" ] \
   || [ -d "$TARGET/skills" ] || [ -d "$TARGET/commands" ] || [ -d "$TARGET/agents" ]; then
  : # valid
else
  echo "  [warn] Cloned repo does not look like a Claude Code plugin."
  echo "  [warn] Keeping clone but verify manually: $TARGET"
fi

echo ""
echo "Caveman installed at: $TARGET"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code (or run /plugin reload)"
echo "  2. Verify with: /caveman-help"
echo "  3. Toggle mode: /caveman lite|full|ultra"
echo ""
