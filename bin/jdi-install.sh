#!/usr/bin/env bash
# jdi-install: copia runtimes/<runtime>/ pra destino do runtime.
# Uso: ./bin/jdi-install.sh <runtime> [--scope user|project] [--githooks]
#   runtime:    claude | copilot | antigravity | opencode | junie | all
#   scope:      user (global) | project (default)
#   --githooks: opt-in — copia hooks no-op pra .githooks/ (shell no repo do
#               consumidor; desligado por padrao pela invariante
#               no-code-in-consumer-repo)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="${1:?runtime obrigatorio: claude | copilot | antigravity | opencode | junie | all}"
SCOPE_ARG="${2:---scope project}"

case "$SCOPE_ARG" in
  --scope=user|--scope\ user)    SCOPE=user ;;
  --scope=project|--scope\ project) SCOPE=project ;;
  *)                                SCOPE=project ;;
esac

[[ "${2:-}" == "--scope" ]] && SCOPE="${3:-project}"

readonly SCOPE_PROJECT="project"

GITHOOKS=0
for arg in "$@"; do
  [[ "$arg" == "--githooks" ]] && GITHOOKS=1
done

# Idioma de instalacao — vem de bin/jdi.js via env (JDI_LANG=en|pt-BR),
# nunca de flag deste script (mantem os .sh/.ps1 sem --lang proprio).
readonly LANG_PT_BR="pt-BR"
JDI_LANG="${JDI_LANG:-en}"

# Diretiva de idioma: injeta um aviso IDIOMA logo depois do fechamento do
# frontmatter de cada command/agent/skill instalado, quando JDI_LANG=pt-BR.
# O build (core/ -> runtimes/) fica neutro de idioma; a injecao acontece
# so aqui, no install, pra runtimes/ nao mudar (S1192: caminho extraido
# pra constante, referenciado nas 3 funcoes abaixo).
readonly LANG_DIRECTIVE_FILE="$ROOT/core/templates/lang-directive.pt-BR.md"
readonly LANG_DIRECTIVE_MARKER='<!-- jdi:lang-directive -->'

# Injeta a diretiva num unico arquivo .md, logo apos o `---` de
# fechamento do frontmatter. Idempotente (nao duplica se o marker ja
# estiver no arquivo). Ignora silenciosamente arquivo inexistente.
inject_lang_directive_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  grep -qF "$LANG_DIRECTIVE_MARKER" "$file" && return 0

  local tmp
  tmp="$(mktemp)"
  awk -v directive_file="$LANG_DIRECTIVE_FILE" '
    /^---$/ && fm < 2 {
      fm++
      print
      if (fm == 2) {
        while ((getline line < directive_file) > 0) print line
        close(directive_file)
      }
      next
    }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

# Aplica a injecao a todo .md de 1o nivel num diretorio (agents/, commands/,
# prompts/). Silencioso se o diretorio nao existir ou estiver vazio.
inject_lang_directive_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  local f
  for f in "$dir"/*.md; do
    [[ -e "$f" ]] || continue
    inject_lang_directive_file "$f"
  done
}

# Aplica a injecao a todo skills/<nome>/SKILL.md sob um diretorio.
inject_lang_directive_skills() {
  local skills_root="$1"
  [[ -d "$skills_root" ]] || return 0
  local f
  for f in "$skills_root"/*/SKILL.md; do
    [[ -e "$f" ]] || continue
    inject_lang_directive_file "$f"
  done
}

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

  if [[ "$JDI_LANG" == "$LANG_PT_BR" ]]; then
    inject_lang_directive_dir "$dest/agents"
    inject_lang_directive_dir "$dest/commands"
    inject_lang_directive_skills "$dest/skills"
  fi

  if [[ "$SCOPE" == "$SCOPE_PROJECT" ]]; then
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
  mkdir -p "$dest/agents" "$dest/prompts" "$dest/skills"
  cp -R "$ROOT/runtimes/copilot/agents/." "$dest/agents/"
  cp -R "$ROOT/runtimes/copilot/prompts/." "$dest/prompts/"
  # Skills servem as 3 superficies: Copilot CLI (que NAO le .github/prompts/),
  # VS Code agent mode e o coding agent do github.com
  cp -R "$ROOT/runtimes/copilot/skills/." "$dest/skills/"
  cp "$ROOT/runtimes/copilot/copilot-instructions.md" "$dest/copilot-instructions.md"

  if [[ "$JDI_LANG" == "$LANG_PT_BR" ]]; then
    inject_lang_directive_dir "$dest/agents"
    inject_lang_directive_dir "$dest/prompts"
    inject_lang_directive_skills "$dest/skills"
  fi

  # Coding agent (issues delegadas): setup do ambiente + gate de artefatos.
  # Nunca sobrescreve workflows existentes do consumidor.
  if [[ -d "$ROOT/runtimes/copilot/workflows" ]]; then
    mkdir -p "$dest/workflows"
    for wf in "$ROOT/runtimes/copilot/workflows/"*.yml; do
      wf_name=$(basename "$wf")
      if [[ -f "$dest/workflows/$wf_name" ]]; then
        echo "  -> workflows/$wf_name ja existe — preservado (compare com runtimes/copilot/workflows/)"
      else
        cp "$wf" "$dest/workflows/$wf_name"
        echo "  -> workflows/$wf_name instalado"
      fi
    done
  fi

  echo "Copilot instalado em: $dest"
  echo "  -> Copilot e sempre project-scoped via .github/"
  echo "  -> CLI: comandos JDI aparecem como skills ('/skills reload' na sessao; digite '/jdi-status' na mensagem)"
  echo "  -> coding agent (issues delegadas): persona jdi-solo + workflows copilot-setup-steps/jdi-artifacts-gate"
  echo "     use --githooks pra ativar o gate pre-commit dentro da sessao do agente"
}

install_antigravity() {
  # Antigravity 2.0 (May 2026) canonical skill paths:
  #   user scope    -> ~/.gemini/config/skills/   (whole suite: IDE + agy CLI)
  #   project scope -> <root>/.agents/skills/     (tool-agnostic workspace dir)
  # The 1.x path (~/.gemini/antigravity/) is no longer read by 2.0.
  local dest
  if [[ "$SCOPE" == "user" ]]; then
    dest="$HOME/.gemini/config"
  else
    dest="$PWD/.agents"
  fi
  mkdir -p "$dest/skills"
  cp -R "$ROOT/runtimes/antigravity/skills/." "$dest/skills/"

  if [[ "$JDI_LANG" == "$LANG_PT_BR" ]]; then
    inject_lang_directive_skills "$dest/skills"
  fi

  if [[ "$SCOPE" == "$SCOPE_PROJECT" ]]; then
    cp "$ROOT/runtimes/antigravity/agents.md" "$dest/agents.md"
  fi

  echo "Antigravity 2.0 instalado em: $dest/skills (scope=$SCOPE)"

  # Legacy 1.x install detected? Point the user to the migration.
  local legacy=""
  [[ -d "$HOME/.gemini/antigravity/skills" ]] && legacy="$HOME/.gemini/antigravity"
  [[ -d "$PWD/.gemini/antigravity/skills" ]] && legacy="${legacy:+$legacy, }$PWD/.gemini/antigravity"
  if [[ -n "$legacy" ]]; then
    echo "  aviso: instalacao Antigravity 1.x detectada em: $legacy"
    echo "         o 2.0 nao le esse diretorio. 'jdi update' migra; 'jdi uninstall antigravity' limpa."
  fi
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

  if [[ "$JDI_LANG" == "$LANG_PT_BR" ]]; then
    inject_lang_directive_dir "$dest/agents"
    inject_lang_directive_dir "$dest/commands"
    inject_lang_directive_skills "$dest/skills"
  fi

  if [[ "$SCOPE" == "$SCOPE_PROJECT" ]]; then
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

install_junie() {
  # Junie CLI (JetBrains, beta 2026): commands sao SKILLS (semantic discovery,
  # .junie/skills/<n>/SKILL.md) e agents sao SUBAGENTS (.junie/agents/<n>.md,
  # tools allowlist enforced). Custom commands do Junie exigem args nomeados
  # obrigatorios — incompativel com os corpos JDI; skills nao tem o problema.
  local dest
  if [[ "$SCOPE" == "user" ]]; then
    dest="$HOME/.junie"
  else
    dest="$PWD/.junie"
  fi
  mkdir -p "$dest/agents" "$dest/skills"
  cp -R "$ROOT/runtimes/junie/agents/." "$dest/agents/"
  cp -R "$ROOT/runtimes/junie/skills/." "$dest/skills/"

  if [[ "$JDI_LANG" == "$LANG_PT_BR" ]]; then
    inject_lang_directive_dir "$dest/agents"
    inject_lang_directive_skills "$dest/skills"
  fi

  if [[ "$SCOPE" == "$SCOPE_PROJECT" ]]; then
    cp "$ROOT/runtimes/junie/AGENTS.md" "$dest/AGENTS.md"
    # Specialists gerados pelo bootstrap: Junie delega por .junie/agents/
    if ls "$PWD/.jdi/agents/"jdi-*.md >/dev/null 2>&1; then
      cp "$PWD/.jdi/agents/"jdi-*.md "$dest/agents/"
      echo "  -> specialists de .jdi/agents/ copiados pra .junie/agents/ (delegacao Junie)"
    else
      echo "  -> apos /jdi-bootstrap, rode 'jdi install junie' de novo pra copiar os specialists"
    fi
  fi

  echo "Junie instalado em: $dest (scope=$SCOPE)"
}

case "$RUNTIME" in
  claude)      install_claude ;;
  copilot)     install_copilot ;;
  antigravity) install_antigravity ;;
  opencode)    install_opencode ;;
  junie)       install_junie ;;
  all)         install_claude && install_copilot && install_antigravity && install_opencode && install_junie ;;
  *)           echo "runtime invalido: $RUNTIME"; exit 1 ;;
esac

# Opt-in: shell scripts no repo do consumidor so com pedido explicito.
if [[ "$GITHOOKS" -eq 1 ]]; then
  install_githooks
else
  echo "  (git hooks nao instalados — opcional via --githooks)"
fi

# Escreve .jdi/VERSION pra rastreio em updates futuros
if [[ -d "$PWD/.jdi" ]]; then
  pkg_version=$(grep -oE '"version":\s*"[^"]+"' "$ROOT/package.json" | head -1 | sed 's/.*"\([^"]*\)"/\1/')
  printf '%s' "$pkg_version" > "$PWD/.jdi/VERSION"
  # Escreve .jdi/LANG pra jdi update reaplicar a diretiva sem exigir --lang de novo
  printf '%s' "$JDI_LANG" > "$PWD/.jdi/LANG"
fi
