#!/usr/bin/env bash
# jdi-install: copia runtimes/<runtime>/ pra destino do runtime.
# Uso: ./bin/jdi-install.sh <runtime> [--scope user|project]
#   runtime: claude | copilot | antigravity | all
#   scope:   user (global) | project (default)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="${1:?runtime obrigatorio: claude | copilot | antigravity | opencode | all}"
SCOPE_ARG="${2:---scope project}"

case "$SCOPE_ARG" in
  --scope=user|--scope\ user)    SCOPE=user ;;
  --scope=project|--scope\ project) SCOPE=project ;;
  *)                                SCOPE=project ;;
esac

[[ "$2" == "--scope" ]] && SCOPE="${3:-project}"

install_claude() {
  local dest
  if [[ "$SCOPE" == "user" ]]; then
    dest="$HOME/.claude"
  else
    dest="$PWD/.claude"
  fi
  mkdir -p "$dest/agents" "$dest/commands" "$dest/skills"

  cp -R "$ROOT/runtimes/claude/agents/." "$dest/agents/"
  cp -R "$ROOT/runtimes/claude/commands/." "$dest/commands/"
  if [[ -d "$ROOT/runtimes/claude/skills" ]]; then
    cp -R "$ROOT/runtimes/claude/skills/." "$dest/skills/"
  fi

  if [[ "$SCOPE" == "project" ]]; then
    cp "$ROOT/runtimes/claude/CLAUDE.md" "$PWD/CLAUDE.md"
    if [[ -f "$ROOT/runtimes/claude/settings.example.json" ]]; then
      mkdir -p "$dest"
      cp -n "$ROOT/runtimes/claude/settings.example.json" "$dest/settings.example.json"
      echo "  -> revise $dest/settings.example.json e renomeie para settings.json (ou .local.json)"
    fi
  fi

  echo "Claude Code instalado em: $dest (scope=$SCOPE)"
}

install_copilot() {
  local dest="$PWD/.github"
  mkdir -p "$dest/agents" "$dest/prompts"
  cp -R "$ROOT/runtimes/copilot/agents/." "$dest/agents/"
  cp -R "$ROOT/runtimes/copilot/prompts/." "$dest/prompts/"
  cp "$ROOT/runtimes/copilot/copilot-instructions.md" "$dest/copilot-instructions.md"
  echo "Copilot instalado em: $dest"
  echo "  -> Copilot e sempre project-scoped via .github/"
}

install_antigravity() {
  local dest
  if [[ "$SCOPE" == "user" ]]; then
    dest="$HOME/.gemini/antigravity"
  else
    dest="$PWD/.gemini/antigravity"
  fi
  mkdir -p "$dest/skills"
  cp -R "$ROOT/runtimes/antigravity/skills/." "$dest/skills/"

  if [[ "$SCOPE" == "project" ]]; then
    cp "$ROOT/runtimes/antigravity/agents.md" "$PWD/agents.md"
  fi

  echo "Antigravity instalado em: $dest (scope=$SCOPE)"
}

install_opencode() {
  local dest
  if [[ "$SCOPE" == "user" ]]; then
    dest="$HOME/.config/opencode"
  else
    dest="$PWD/.opencode"
  fi
  mkdir -p "$dest/agents" "$dest/commands" "$dest/skills"

  cp -R "$ROOT/runtimes/opencode/agents/." "$dest/agents/"
  cp -R "$ROOT/runtimes/opencode/commands/." "$dest/commands/"

  # Skills: OpenCode tambem le .claude/skills/. Se ja instalou Claude, reutiliza.
  if [[ -d "$ROOT/runtimes/opencode/skills" ]]; then
    cp -R "$ROOT/runtimes/opencode/skills/." "$dest/skills/" 2>/dev/null || true
  fi

  if [[ "$SCOPE" == "project" ]]; then
    cp "$ROOT/runtimes/opencode/AGENTS.md" "$PWD/AGENTS.md"
    if [[ ! -f "$dest/opencode.jsonc" ]]; then
      cp "$ROOT/runtimes/opencode/opencode.example.jsonc" "$dest/opencode.jsonc"
      echo "  -> revise $dest/opencode.jsonc (gerado a partir do exemplo)"
    fi
  fi

  echo "OpenCode instalado em: $dest (scope=$SCOPE)"
}

install_githooks() {
  local hooks_dir="$PWD/.githooks"
  mkdir -p "$hooks_dir"
  if [[ -f "$ROOT/bin/git-hooks/pre-commit" ]]; then
    cp "$ROOT/bin/git-hooks/pre-commit" "$hooks_dir/pre-commit"
    chmod +x "$hooks_dir/pre-commit"
  fi
  if [[ -f "$ROOT/bin/git-hooks/post-commit" ]]; then
    cp "$ROOT/bin/git-hooks/post-commit" "$hooks_dir/post-commit"
    chmod +x "$hooks_dir/post-commit"
  fi

  echo
  echo "Git hooks copiados pra .githooks/. Para ativar:"
  echo "  git config core.hooksPath .githooks"
}

case "$RUNTIME" in
  claude)      install_claude ;;
  copilot)     install_copilot ;;
  antigravity) install_antigravity ;;
  opencode)    install_opencode ;;
  all)         install_claude && install_copilot && install_antigravity && install_opencode ;;
  *)           echo "runtime invalido: $RUNTIME"; exit 1 ;;
esac

install_githooks

# Escreve .jdi/VERSION pra rastreio em updates futuros
if [[ -d "$PWD/.jdi" ]]; then
  pkg_version=$(grep -oE '"version":\s*"[^"]+"' "$ROOT/package.json" | head -1 | sed 's/.*"\([^"]*\)"/\1/')
  printf '%s' "$pkg_version" > "$PWD/.jdi/VERSION"
fi
