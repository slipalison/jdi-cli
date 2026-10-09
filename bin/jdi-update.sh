#!/usr/bin/env bash
# jdi-update: atualiza JDI em projeto que ja tem JDI instalado.
#
# - Detecta runtimes instalados no projeto
# - Sobrescreve runtime files (agents, commands, skills) - shipped pelo JDI
# - NUNCA toca state files (.jdi/PROJECT.md, DECISIONS.md, etc)
# - Atualiza os blocos gerenciados dos specialists (jdi:managed) e aponta
#   `specialists upgrade --adopt` para os gerados antes da 0.17
# - Atualiza .jdi/VERSION
#
# Flags:
#   --force-specialists  Indica /jdi-bootstrap (Recriar) para specialists antigos
#   --skip-specialists   Nao mexe em specialists (nem nos blocos gerenciados)
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
    *) : ;;  # ignora flags desconhecidas
  esac
done

# Le versao nova do package.json shipado
NEW_VERSION=$(grep -oE '"version":\s*"[^"]+"' "$ROOT/package.json" | head -1 | sed 's/.*"\([^"]*\)"/\1/')

# Idioma: JDI_LANG so chega setado quando o usuario passou --lang em
# `jdi update` (ver bin/jdi.js). Sem override explicito, cai no idioma
# persistido em .jdi/LANG (escrito pelo install). Sem esse arquivo
# (projeto pre-i18n, ou greenfield onde o install rodou antes de .jdi/
# existir), infere pelo marker da diretiva nos arquivos instalados —
# senao o update reverteria pt-BR pra 'en' silenciosamente ao re-copiar.
# Export pra jdi-install.sh (subprocesso abaixo) herdar via ambiente.
LANG_FILE="$PROJECT_DIR/.jdi/LANG"
EXPLICIT_LANG="${JDI_LANG:-}"
if [[ -f "$LANG_FILE" ]]; then
  # tr tambem remove BOM UTF-8 (\357\273\277): versoes antigas do install.ps1
  # em PS 5.1 gravavam BOM via Set-Content -Encoding UTF8.
  CURRENT_LANG="$(tr -d '[:space:]\357\273\277' < "$LANG_FILE")"
else
  CURRENT_LANG="en"
  for probe_dir in .claude/commands .github/prompts .opencode/commands .agents/skills/jdi-new .junie/skills/jdi-new; do
    if [[ -d "$PROJECT_DIR/$probe_dir" ]] && grep -rqF '<!-- jdi:lang-directive -->' "$PROJECT_DIR/$probe_dir" 2>/dev/null; then
      CURRENT_LANG="pt-BR"
      break
    fi
  done
fi
JDI_LANG="${EXPLICIT_LANG:-$CURRENT_LANG}"
export JDI_LANG

# Pre-flight
if [[ ! -d "$PROJECT_DIR/.jdi" ]]; then
  echo "Esse diretorio nao tem .jdi/. Use 'npx jdi-cli install <runtime>' pra primeira instalacao."
  exit 1
fi

# Le versao instalada
VERSION_FILE="$PROJECT_DIR/.jdi/VERSION"
if [[ -f "$VERSION_FILE" ]]; then
  OLD_VERSION=$(tr -d '[:space:]\357\273\277' < "$VERSION_FILE")
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
  # Troca de idioma explicita na mesma versao NAO e no-op: precisa
  # re-copiar os runtime files pra injetar/remover a diretiva.
  if [[ -n "$EXPLICIT_LANG" && "$EXPLICIT_LANG" != "$CURRENT_LANG" ]]; then
    echo "Mesma versao ($NEW_VERSION), mas --lang mudou ($CURRENT_LANG -> $EXPLICIT_LANG) — reaplicando runtime files."
    echo
  else
    echo "Ja na versao mais recente ($NEW_VERSION)."
    exit 0
  fi
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

# Antigravity 2.0 paths (+ legacy 1.x for migration)
if [[ -d "$PROJECT_DIR/.agents/skills/jdi-architect" ]] || [[ -d "$USER_HOME/.gemini/config/skills/jdi-architect" ]] \
   || [[ -d "$PROJECT_DIR/.gemini/antigravity" ]] || [[ -d "$USER_HOME/.gemini/antigravity/skills/jdi-architect" ]]; then
  detected+=("antigravity")
fi

if [[ -d "$PROJECT_DIR/.opencode" ]] || [[ -f "$USER_HOME/.config/opencode/agents/jdi-architect.md" ]]; then
  detected+=("opencode")
fi

if [[ -f "$PROJECT_DIR/.junie/agents/jdi-architect.md" ]] || [[ -f "$USER_HOME/.junie/agents/jdi-architect.md" ]]; then
  detected+=("junie")
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
  USER_LEGACY=""; PROJ_LEGACY=""
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
      # 2.0 markers; 1.x legado dispara migracao (instala no novo + remove o velho)
      USER_MARKER="$USER_HOME/.gemini/config/skills/jdi-architect"
      PROJ_MARKER="$PROJECT_DIR/.agents/skills/jdi-architect"
      USER_LEGACY="$USER_HOME/.gemini/antigravity"
      PROJ_LEGACY="$PROJECT_DIR/.gemini/antigravity"
      ;;
    opencode)
      USER_MARKER="$USER_HOME/.config/opencode/agents/jdi-architect.md"
      PROJ_MARKER="$PROJECT_DIR/.opencode/agents/jdi-architect.md"
      ;;
    junie)
      USER_MARKER="$USER_HOME/.junie/agents/jdi-architect.md"
      PROJ_MARKER="$PROJECT_DIR/.junie/agents/jdi-architect.md"
      ;;
    *)
      USER_MARKER=""
      PROJ_MARKER=""
      ;;
  esac

  if [[ -e "$PROJ_MARKER" ]] || [[ -n "$PROJ_LEGACY" && -d "$PROJ_LEGACY/skills" ]]; then
    echo "Atualizando $runtime (project scope)..."
    if [[ $DRY_RUN -eq 0 ]]; then
      bash "$INSTALL_SCRIPT" "$runtime" --scope project >/dev/null
      if [[ -n "$PROJ_LEGACY" && -d "$PROJ_LEGACY/skills" ]]; then
        rm -rf "$PROJ_LEGACY"
        echo "  migrado: skills 1.x removidas de $PROJ_LEGACY (2.0 usa .agents/skills/)"
      fi
    else
      echo "  [dry-run] copia runtimes/$runtime/* pra escopo project"
      [[ -n "$PROJ_LEGACY" && -d "$PROJ_LEGACY/skills" ]] && echo "  [dry-run] migra 1.x: remove $PROJ_LEGACY"
    fi
  fi

  if [[ -n "$USER_MARKER" && -e "$USER_MARKER" ]] || [[ -n "$USER_LEGACY" && -d "$USER_LEGACY/skills" ]]; then
    echo "Atualizando $runtime (user scope)..."
    if [[ $DRY_RUN -eq 0 ]]; then
      bash "$INSTALL_SCRIPT" "$runtime" --scope user >/dev/null
      if [[ -n "$USER_LEGACY" && -d "$USER_LEGACY/skills" ]]; then
        rm -rf "$USER_LEGACY"
        echo "  migrado: skills 1.x removidas de $USER_LEGACY (2.0 usa ~/.gemini/config/skills/)"
      fi
    else
      echo "  [dry-run] copia runtimes/$runtime/* pra escopo user"
      [[ -n "$USER_LEGACY" && -d "$USER_LEGACY/skills" ]] && echo "  [dry-run] migra 1.x: remove $USER_LEGACY"
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

  # Desde a 0.17 as partes do JDI nos specialists (entradas, regras de
  # trabalho, retorno curto) sao BLOCOS GERENCIADOS
  # (<!-- jdi:managed id=... -->): o update troca so esses blocos e mantem
  # byte a byte tudo o que o projeto escreveu fora deles. Specialists sem
  # blocos (gerados antes da 0.17) precisam de `specialists upgrade --adopt`
  # uma vez — mostra a diferenca antes de gravar.
  if [[ $SKIP_SPECIALISTS -eq 1 ]]; then
    echo "  Specialists mantidos como estao (--skip-specialists)."
  elif [[ $DRY_RUN -eq 1 ]]; then
    (cd "$PROJECT_DIR" && node "$ROOT/bin/jdi.js" specialists upgrade) || true
  else
    (cd "$PROJECT_DIR" && node "$ROOT/bin/jdi.js" specialists upgrade --write) || true
    (cd "$PROJECT_DIR" && JDI_LANG="$JDI_LANG" bash "$ROOT/bin/lib/jdi-sync-specialists.sh" all --quiet) || true
  fi
  legacy=0
  for s in "${specialists[@]}"; do
    grep -q '<!-- jdi:managed id=' "$s" || { legacy=1; break; }
  done
  if [[ $legacy -eq 1 ]]; then
    echo
    echo "Specialists gerados antes da 0.17 (sem blocos gerenciados): as entradas"
    echo "(brief), o retorno curto e as regras novas so chegam a eles com:"
    echo "  npx -y jdi-cli@$NEW_VERSION specialists upgrade --adopt          # mostra a diferenca"
    echo "  npx -y jdi-cli@$NEW_VERSION specialists upgrade --adopt --write  # grava"
    echo "  npx -y jdi-cli@$NEW_VERSION sync-specialists"
    echo "Tudo fora dos blocos e preservado. Alternativa: /jdi-bootstrap (Recriar)."
    if [[ $FORCE_SPECIALISTS -eq 1 ]]; then
      echo
      echo "ACAO MANUAL NECESSARIA (--force-specialists):"
      echo "  Abra teu runtime e rode:  /jdi-bootstrap"
      echo "  Architect vai detectar specialists existentes e oferecer 'Recriar'."
    fi
  fi
  echo "  Auditoria: npx -y jdi-cli@$NEW_VERSION specialists lint"
fi

# =========================================================
# Atualiza .jdi/VERSION
# =========================================================

if [[ $DRY_RUN -eq 0 ]]; then
  printf '%s' "$NEW_VERSION" > "$VERSION_FILE"
  printf '%s' "$JDI_LANG" > "$LANG_FILE"
fi

echo
echo "JDI atualizado: $OLD_VERSION -> $NEW_VERSION"
[[ $DRY_RUN -eq 1 ]] && echo "(dry-run - nada foi mudado)"
echo
echo "Changelog: https://github.com/slipalison/jdi-cli/releases"
