#!/usr/bin/env bash
# jdi-update: atualiza JDI em projeto que ja tem JDI instalado.
#
# - Detecta runtimes instalados no projeto
# - Sobrescreve runtime files (agents, commands, skills) - shipped pelo JDI
# - NUNCA toca state files (.jdi/PROJECT.md, DECISIONS.md, etc)
# - Detecta specialists e pergunta se regenera
# - Atualiza .jdi/VERSION
#
# Flags:
#   --force-specialists  Regenera specialists sem perguntar
#   --skip-specialists   Nao mexe em specialists
#   --dry-run            Mostra o que faria

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$(pwd)"
USER_HOME="${HOME:-$HOME}"

FORCE_SPECIALISTS=0
SKIP_SPECIALISTS=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --force-specialists) FORCE_SPECIALISTS=1 ;;
    --skip-specialists)  SKIP_SPECIALISTS=1 ;;
    --dry-run)           DRY_RUN=1 ;;
  esac
done

# Le versao nova do package.json shipado
NEW_VERSION=$(grep -oE '"version":\s*"[^"]+"' "$ROOT/package.json" | head -1 | sed 's/.*"\([^"]*\)"/\1/')

# Pre-flight
if [[ ! -d "$PROJECT_DIR/.jdi" ]]; then
  echo "Esse diretorio nao tem .jdi/. Use 'npx jdi-cli install <runtime>' pra primeira instalacao."
  exit 1
fi

# Le versao instalada
VERSION_FILE="$PROJECT_DIR/.jdi/VERSION"
if [[ -f "$VERSION_FILE" ]]; then
  OLD_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
else
  OLD_VERSION="unknown (pre-1.2.1)"
fi

echo
echo "JDI Update"
echo "  De:   $OLD_VERSION"
echo "  Para: $NEW_VERSION"
echo "  Dir:  $PROJECT_DIR"
[[ $DRY_RUN -eq 1 ]] && echo "  Mode: DRY-RUN (sem mudancas)"
echo

if [[ "$OLD_VERSION" == "$NEW_VERSION" && $DRY_RUN -eq 0 ]]; then
  echo "Ja na versao mais recente ($NEW_VERSION)."
  exit 0
fi

# =========================================================
# Detecta runtimes instalados
# =========================================================

detected=()

if [[ -d "$PROJECT_DIR/.claude" ]] || [[ -f "$USER_HOME/.claude/agents/jdi-architect.md" ]]; then
  detected+=("claude")
fi

if [[ -d "$PROJECT_DIR/.github/agents" ]] && ls "$PROJECT_DIR/.github/agents/jdi-"*.agent.md >/dev/null 2>&1; then
  detected+=("copilot")
fi

if [[ -d "$PROJECT_DIR/.gemini/antigravity" ]] || [[ -d "$USER_HOME/.gemini/antigravity/skills/jdi-architect" ]]; then
  detected+=("antigravity")
fi

if [[ -d "$PROJECT_DIR/.opencode" ]] || [[ -f "$USER_HOME/.config/opencode/agents/jdi-architect.md" ]]; then
  detected+=("opencode")
fi

if [[ ${#detected[@]} -eq 0 ]]; then
  echo "Nenhum runtime JDI detectado. Tem .jdi/ mas nao .claude/, .github/, .gemini/, .opencode/."
  echo "Use 'npx jdi-cli install <runtime>' pra instalar."
  exit 1
fi

echo "Runtimes detectados: ${detected[*]}"
echo

# =========================================================
# Atualiza runtime files (sobrescreve via install)
# =========================================================

INSTALL_SCRIPT="$ROOT/bin/jdi-install.sh"

for runtime in "${detected[@]}"; do
  # Detecta scope - se tem em user dir, atualiza user; se tem em project, atualiza project
  case "$runtime" in
    claude)
      USER_MARKER="$USER_HOME/.claude/agents/jdi-architect.md"
      PROJ_MARKER="$PROJECT_DIR/.claude/agents/jdi-architect.md"
      ;;
    copilot)
      USER_MARKER=""
      PROJ_MARKER="$PROJECT_DIR/.github/agents/jdi-architect.agent.md"
      ;;
    antigravity)
      USER_MARKER="$USER_HOME/.gemini/antigravity/skills/jdi-architect"
      PROJ_MARKER="$PROJECT_DIR/.gemini/antigravity/skills/jdi-architect"
      ;;
    opencode)
      USER_MARKER="$USER_HOME/.config/opencode/agents/jdi-architect.md"
      PROJ_MARKER="$PROJECT_DIR/.opencode/agents/jdi-architect.md"
      ;;
  esac

  if [[ -e "$PROJ_MARKER" ]]; then
    echo "Atualizando $runtime (project scope)..."
    if [[ $DRY_RUN -eq 0 ]]; then
      bash "$INSTALL_SCRIPT" "$runtime" --scope project >/dev/null
    else
      echo "  [dry-run] copia runtimes/$runtime/* pra escopo project"
    fi
  fi

  if [[ -n "$USER_MARKER" && -e "$USER_MARKER" ]]; then
    echo "Atualizando $runtime (user scope)..."
    if [[ $DRY_RUN -eq 0 ]]; then
      bash "$INSTALL_SCRIPT" "$runtime" --scope user >/dev/null
    else
      echo "  [dry-run] copia runtimes/$runtime/* pra escopo user"
    fi
  fi
done

echo

# =========================================================
# Detecta specialists e oferece regen
# =========================================================

specialist_dir="$PROJECT_DIR/.jdi/agents"
specialists=()

if [[ -d "$specialist_dir" ]]; then
  while IFS= read -r f; do specialists+=("$f"); done < <(ls "$specialist_dir"/jdi-doer-*.md "$specialist_dir"/jdi-reviewer-*.md 2>/dev/null || true)
fi

if [[ ${#specialists[@]} -gt 0 ]]; then
  echo "Specialists detectados em .jdi/agents/:"
  for s in "${specialists[@]}"; do echo "  - $(basename "$s")"; done
  echo

  # Heuristica: specialists novos tem <skills_to_load>
  needs_regen=0
  for s in "${specialists[@]}"; do
    if ! grep -q '<skills_to_load>' "$s"; then
      needs_regen=1
      break
    fi
  done

  if [[ $needs_regen -eq 1 ]]; then
    echo "Specialists existentes NAO tem <skills_to_load> - foram gerados antes da 1.2.1."
    echo "Pra ativar skills universais (DRY/KISS/YAGNI/SOLID/Clean Code) via eager loading,"
    echo "specialists precisam ser regenerados."
    echo

    should_regen=0
    if [[ $FORCE_SPECIALISTS -eq 1 ]]; then
      should_regen=1
    elif [[ $SKIP_SPECIALISTS -eq 1 ]]; then
      should_regen=0
    else
      read -r -p "Regenerar specialists? Vai rodar /jdi-bootstrap (Y/n) " resp
      if [[ -z "$resp" || "$resp" =~ ^[YySs] ]]; then should_regen=1; fi
    fi

    if [[ $should_regen -eq 1 ]]; then
      echo
      echo "ACAO MANUAL NECESSARIA:"
      echo "  Abra teu runtime e rode:  /jdi-bootstrap"
      echo "  Architect vai detectar specialists existentes e oferecer 'Recriar'."
      echo "  Os specialists novos terao <skills_to_load> com as 5 universais wired."
    else
      echo "  Specialists mantidos - skills universais ficam em modo discoverable only."
    fi
  else
    echo "Specialists ja tem <skills_to_load> - up to date."
  fi
fi

# =========================================================
# Atualiza .jdi/VERSION
# =========================================================

if [[ $DRY_RUN -eq 0 ]]; then
  printf '%s' "$NEW_VERSION" > "$VERSION_FILE"
fi

echo
echo "JDI atualizado: $OLD_VERSION -> $NEW_VERSION"
[[ $DRY_RUN -eq 1 ]] && echo "(dry-run - nada foi mudado)"
echo
echo "Changelog: https://github.com/slipalison/jdi-cli/releases"
