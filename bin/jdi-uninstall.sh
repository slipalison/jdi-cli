#!/usr/bin/env bash
# jdi-uninstall: remove JDI do projeto.
#
# - Default: NAO remove .jdi/ (state files - decisoes locked, roadmap)
# - --purge: remove TUDO incluindo .jdi/
# - --runtime <name>: especifico
# - --scope user|project|both: especifico (default: both)
# - --yes: pula confirmacoes
# - --dry-run: mostra sem aplicar
#
# SEMPRE pede confirmacao por padrao - acao destrutiva.

set -euo pipefail

PROJECT_DIR="$(pwd)"
USER_HOME="${HOME:-$HOME}"

# Skills universais shipped pelo JDI (runtimes/<rt>/skills/). Mantenha em sync com o ship.
UNIVERSAL_SKILLS=(
  clean-architecture clean-code ddd dry
  frontend-rules frontend-validator
  hexagonal kiss onion solid
  the-method vertical-slice yagni
)

RUNTIME="all"
SCOPE="both"
PURGE=0
YES=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime) RUNTIME="$2"; shift 2 ;;
    --scope)   SCOPE="$2"; shift 2 ;;
    --purge)   PURGE=1; shift ;;
    --yes|-y)  YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) shift ;;
  esac
done

confirm_action() {
  local msg="$1"
  if [[ $YES -eq 1 || $DRY_RUN -eq 1 ]]; then return 0; fi
  read -r -p "$msg (y/N) " resp
  [[ "$resp" =~ ^[YySs] ]]
}

remove_safe() {
  local path="$1"
  local label="$2"
  [[ ! -e "$path" ]] && return 0

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] removeria: $path"
    return 0
  fi

  rm -rf "$path"
  echo "  removido: $label"
}

uninstall_claude() {
  local scope="$1"
  local targets=()
  [[ "$scope" == "project" || "$scope" == "both" ]] && targets+=("$PROJECT_DIR/.claude:project")
  [[ "$scope" == "user" || "$scope" == "both" ]] && targets+=("$USER_HOME/.claude:user")

  for t in "${targets[@]}"; do
    local dir="${t%:*}"
    local sc="${t#*:}"
    [[ ! -d "$dir" ]] && continue

    echo
    echo "Claude ($sc scope) em: $dir"

    if [[ -d "$dir/agents" ]]; then
      for f in "$dir/agents"/jdi-*.md; do
        [[ -f "$f" ]] && remove_safe "$f" "agents/$(basename "$f")"
      done
    fi

    if [[ -d "$dir/commands" ]]; then
      for f in "$dir/commands"/jdi-*.md; do
        [[ -f "$f" ]] && remove_safe "$f" "commands/$(basename "$f")"
      done
    fi

    if [[ -d "$dir/skills" ]]; then
      for skill in "${UNIVERSAL_SKILLS[@]}"; do
        remove_safe "$dir/skills/$skill" "skills/$skill/"
      done
    fi

    if [[ "$sc" == "project" ]]; then
      if [[ -f "$PROJECT_DIR/CLAUDE.md" ]]; then
        if confirm_action "Remover CLAUDE.md? (pode ter sido editado)"; then
          remove_safe "$PROJECT_DIR/CLAUDE.md" "CLAUDE.md"
        fi
      fi
    fi
  done
}

uninstall_copilot() {
  local dest="$PROJECT_DIR/.github"
  [[ ! -d "$dest" ]] && return 0

  echo
  echo "Copilot (project scope) em: $dest"

  if [[ -d "$dest/agents" ]]; then
    for f in "$dest/agents"/jdi-*.agent.md; do
      [[ -f "$f" ]] && remove_safe "$f" "agents/$(basename "$f")"
    done
  fi

  if [[ -d "$dest/prompts" ]]; then
    for f in "$dest/prompts"/jdi-*.prompt.md; do
      [[ -f "$f" ]] && remove_safe "$f" "prompts/$(basename "$f")"
    done
  fi

  if [[ -f "$dest/copilot-instructions.md" ]]; then
    if confirm_action "Remover .github/copilot-instructions.md? (pode ter sido editado)"; then
      remove_safe "$dest/copilot-instructions.md" ".github/copilot-instructions.md"
    fi
  fi
}

uninstall_antigravity() {
  local scope="$1"
  local targets=()
  [[ "$scope" == "project" || "$scope" == "both" ]] && targets+=("$PROJECT_DIR/.gemini/antigravity:project")
  [[ "$scope" == "user" || "$scope" == "both" ]] && targets+=("$USER_HOME/.gemini/antigravity:user")

  for t in "${targets[@]}"; do
    local dir="${t%:*}"
    local sc="${t#*:}"
    [[ ! -d "$dir" ]] && continue

    echo
    echo "Antigravity ($sc scope) em: $dir"

    if [[ -d "$dir/skills" ]]; then
      # jdi-* skills (cada uma eh dir)
      for sd in "$dir/skills"/jdi-*; do
        [[ -d "$sd" ]] && remove_safe "$sd" "skills/$(basename "$sd")/"
      done
      # universais
      for skill in "${UNIVERSAL_SKILLS[@]}"; do
        remove_safe "$dir/skills/$skill" "skills/$skill/"
      done
    fi

    if [[ "$sc" == "project" && -f "$PROJECT_DIR/agents.md" ]]; then
      if confirm_action "Remover agents.md (Antigravity)? (pode ter sido editado)"; then
        remove_safe "$PROJECT_DIR/agents.md" "agents.md"
      fi
    fi
  done
}

uninstall_opencode() {
  local scope="$1"
  local targets=()
  [[ "$scope" == "project" || "$scope" == "both" ]] && targets+=("$PROJECT_DIR/.opencode:project")
  [[ "$scope" == "user" || "$scope" == "both" ]] && targets+=("$USER_HOME/.config/opencode:user")

  for t in "${targets[@]}"; do
    local dir="${t%:*}"
    local sc="${t#*:}"
    [[ ! -d "$dir" ]] && continue

    echo
    echo "OpenCode ($sc scope) em: $dir"

    if [[ -d "$dir/agents" ]]; then
      for f in "$dir/agents"/jdi-*.md; do
        [[ -f "$f" ]] && remove_safe "$f" "agents/$(basename "$f")"
      done
    fi

    if [[ -d "$dir/commands" ]]; then
      for f in "$dir/commands"/jdi-*.md; do
        [[ -f "$f" ]] && remove_safe "$f" "commands/$(basename "$f")"
      done
    fi

    if [[ -d "$dir/skills" ]]; then
      for skill in "${UNIVERSAL_SKILLS[@]}"; do
        remove_safe "$dir/skills/$skill" "skills/$skill/"
      done
    fi

    if [[ "$sc" == "project" ]]; then
      if [[ -f "$PROJECT_DIR/AGENTS.md" ]]; then
        if confirm_action "Remover AGENTS.md (OpenCode)? (pode ter sido editado)"; then
          remove_safe "$PROJECT_DIR/AGENTS.md" "AGENTS.md"
        fi
      fi
      if [[ -f "$dir/opencode.jsonc" ]]; then
        if confirm_action "Remover .opencode/opencode.jsonc? (pode ter config customizada)"; then
          remove_safe "$dir/opencode.jsonc" ".opencode/opencode.jsonc"
        fi
      fi
    fi
  done
}

# =========================================================
# Main
# =========================================================

echo
echo "JDI Uninstall"
echo "  Dir:     $PROJECT_DIR"
echo "  Runtime: $RUNTIME"
echo "  Scope:   $SCOPE"
[[ $PURGE -eq 1 ]] && echo "  Purge:   YES (vai remover .jdi/ tambem)"
[[ $DRY_RUN -eq 1 ]] && echo "  Mode:    DRY-RUN (sem mudancas)"
echo

if [[ $YES -eq 0 && $DRY_RUN -eq 0 ]]; then
  if ! confirm_action "Continuar com uninstall? (acao destrutiva)"; then
    echo "Cancelado."
    exit 0
  fi
fi

if [[ "$RUNTIME" == "all" ]]; then
  runtimes=("claude" "copilot" "antigravity" "opencode")
else
  runtimes=("$RUNTIME")
fi

for r in "${runtimes[@]}"; do
  case "$r" in
    claude)      uninstall_claude "$SCOPE" ;;
    copilot)     uninstall_copilot ;;
    antigravity) uninstall_antigravity "$SCOPE" ;;
    opencode)    uninstall_opencode "$SCOPE" ;;
  esac
done

# Purge
if [[ $PURGE -eq 1 ]]; then
  echo
  if [[ -d "$PROJECT_DIR/.jdi" ]]; then
    echo "PURGE: removendo .jdi/ (state files - DECISIONS, ROADMAP, phases, etc)"
    if confirm_action "TEM CERTEZA? Isso apaga decisoes locked permanentemente"; then
      remove_safe "$PROJECT_DIR/.jdi" ".jdi/"
    else
      echo "  .jdi/ preservado."
    fi
  fi

  if [[ -d "$PROJECT_DIR/.githooks" ]]; then
    if confirm_action "Remover .githooks/?"; then
      remove_safe "$PROJECT_DIR/.githooks" ".githooks/"
    fi
  fi
fi

echo
echo "Uninstall completo."
[[ $DRY_RUN -eq 1 ]] && echo "(dry-run - nada foi mudado)"
if [[ $PURGE -eq 0 ]]; then
  echo
  echo "Nota: .jdi/ preservado (state files). Use --purge pra remover tambem."
fi
