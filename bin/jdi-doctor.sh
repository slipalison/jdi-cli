#!/usr/bin/env bash
# jdi-doctor: diagnostica ambiente JDI.
# Uso: ./bin/jdi-doctor.sh [--verbose]
#
# Checa:
#  - dependencias bash (git, awk, sed, find)
#  - runtimes detectados (claude, copilot, antigravity)
#  - ctx7 (opcional)
#  - estrutura .jdi/ no projeto atual
#  - git hooks ativos (.githooks/)
#  - source of truth (core/) se rodando do repo JDI
#  - runtimes/ buildados
#  - install no projeto atual
#
# Saida: relatorio com OK / WARN / FAIL por check.
# Exit 0 se tudo OK ou so WARN. Exit 1 se algum FAIL.

set -uo pipefail

VERBOSE="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JDI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$PWD"

# Literais repetidos extraidos pra constante (S1192)
readonly JDI_AGENT_GLOB='jdi-*.md'
readonly PLAYWRIGHT_KEY='"playwright"'

# Cores (sem cor se nao for tty)
if [[ -t 1 ]]; then
  GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  GRN=""; YLW=""; RED=""; DIM=""; RST=""
fi

FAILS=0
WARNS=0

ok()   { local msg="$1"; echo "  ${GRN}OK${RST}    $msg"; return 0; }
warn() { local msg="$1"; echo "  ${YLW}WARN${RST}  $msg"; ((WARNS++)) || true; return 0; }
fail() { local msg="$1"; echo "  ${RED}FAIL${RST}  $msg"; ((FAILS++)) || true; return 0; }
note() { local msg="$1"; [[ "$VERBOSE" == "--verbose" ]] && echo "  ${DIM}note  $msg${RST}" || true; return 0; }
section() { local title="$1"; echo; echo "${title}"; return 0; }

# ---------------------------------------------------------------------------
section "1. Dependencias bash"

for cmd in git awk sed find grep; do
  if command -v "$cmd" &>/dev/null; then
    ok "$cmd disponivel ($(command -v "$cmd"))"
  else
    fail "$cmd ausente. Instale (Linux/Mac nativo. Windows: Git Bash ou WSL)."
  fi
done

# ---------------------------------------------------------------------------
section "2. Runtimes"

CLAUDE_OK=false
if command -v claude &>/dev/null; then
  ok "claude CLI: $(command -v claude)"
  CLAUDE_OK=true
elif [[ -d "$HOME/.claude" ]]; then
  warn "~/.claude/ existe mas claude CLI nao esta no PATH"
  CLAUDE_OK=true
else
  warn "Claude Code nao detectado (sem CLI nem ~/.claude/)"
fi

COPILOT_OK=false
if command -v code &>/dev/null; then
  if code --list-extensions 2>/dev/null | grep -qi "github.copilot"; then
    ok "VS Code + extensao Copilot detectados"
    COPILOT_OK=true
  else
    warn "VS Code presente mas extensao Copilot nao instalada"
  fi
elif command -v gh &>/dev/null && gh extension list 2>/dev/null | grep -qi copilot; then
  ok "gh CLI com extensao copilot"
  COPILOT_OK=true
else
  warn "Copilot nao detectado (sem VS Code ou sem extensao)"
fi

ANTIGRAVITY_OK=false
if command -v agy &>/dev/null; then
  ok "Antigravity CLI 2.0 (agy): $(command -v agy)"
  ANTIGRAVITY_OK=true
elif [[ -d "$HOME/.gemini/config" ]]; then
  ok "~/.gemini/config/ existe (Antigravity 2.0)"
  ANTIGRAVITY_OK=true
elif command -v antigravity &>/dev/null; then
  ok "antigravity CLI (1.x): $(command -v antigravity)"
  ANTIGRAVITY_OK=true
elif [[ -d "$HOME/.gemini/antigravity" ]]; then
  warn "~/.gemini/antigravity/ existe (Antigravity 1.x legado — o 2.0 nao le esse dir; 'jdi update' migra)"
  ANTIGRAVITY_OK=true
else
  warn "Antigravity nao detectado"
fi

JUNIE_OK=false
if command -v junie &>/dev/null; then
  ok "Junie CLI: $(command -v junie)"
  JUNIE_OK=true
elif [[ -d "$HOME/.junie" ]]; then
  ok "~/.junie/ existe"
  JUNIE_OK=true
else
  warn "Junie nao detectado"
fi

OPENCODE_OK=false
if command -v opencode &>/dev/null; then
  ok "opencode CLI: $(command -v opencode)"
  OPENCODE_OK=true
elif [[ -d "$HOME/.config/opencode" ]]; then
  ok "~/.config/opencode/ existe"
  OPENCODE_OK=true
else
  warn "OpenCode nao detectado (sem CLI nem ~/.config/opencode/)"
fi

if ! $CLAUDE_OK && ! $COPILOT_OK && ! $ANTIGRAVITY_OK && ! $OPENCODE_OK; then
  fail "Nenhum runtime detectado. JDI nao serve pra nada sem runtime."
fi

# ---------------------------------------------------------------------------
section "3. Tooling opcional"

if command -v ctx7 &>/dev/null; then
  ok "ctx7 disponivel ($(command -v ctx7))"
elif command -v npx &>/dev/null; then
  warn "ctx7 ausente. Recomendado pra docs de libs. Instale: npm i -g ctx7"
else
  warn "ctx7 e npx ausentes. Researcher fica limitado a WebSearch."
fi

if command -v gh &>/dev/null; then
  ok "gh CLI disponivel (usado por /jdi-ship --pr)"
else
  warn "gh CLI ausente. /jdi-ship --pr nao consegue abrir PR (ship normal funciona). Install: cli.github.com"
fi

if command -v jq &>/dev/null; then
  ok "jq disponivel"
else
  note "jq ausente (opcional, scripts JDI usam awk em vez)"
fi

# ---------------------------------------------------------------------------
section "4. Repo JDI (source of truth)"

if [[ -d "$JDI_ROOT/core/agents" && -d "$JDI_ROOT/core/commands" ]]; then
  AGENTS_COUNT=$(find "$JDI_ROOT/core/agents" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  COMMANDS_COUNT=$(find "$JDI_ROOT/core/commands" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  ok "core/ encontrado ($AGENTS_COUNT agents, $COMMANDS_COUNT commands)"

  if [[ "$AGENTS_COUNT" -lt 1 ]]; then
    fail "core/agents/ vazio. Repo do JDI nao esta integro."
  fi
else
  fail "core/ ausente em $JDI_ROOT. Esse script roda do repo do JDI?"
fi

if [[ -x "$JDI_ROOT/bin/jdi-build.sh" ]]; then
  ok "jdi-build.sh executavel"
else
  warn "jdi-build.sh nao executavel. Rode: chmod +x bin/jdi-build.sh"
fi

if [[ -x "$JDI_ROOT/bin/jdi-install.sh" ]]; then
  ok "jdi-install.sh executavel"
else
  warn "jdi-install.sh nao executavel. Rode: chmod +x bin/jdi-install.sh"
fi

# ---------------------------------------------------------------------------
section "5. Adapters buildados (runtimes/)"

for rt in claude copilot antigravity opencode; do
  if [[ -d "$JDI_ROOT/runtimes/$rt" ]]; then
    case "$rt" in
      claude)      count=$(find "$JDI_ROOT/runtimes/claude/agents" -name "*.md" 2>/dev/null | wc -l | tr -d ' ') ;;
      copilot)     count=$(find "$JDI_ROOT/runtimes/copilot/agents" -name "*.agent.md" 2>/dev/null | wc -l | tr -d ' ') ;;
      antigravity) count=$(find "$JDI_ROOT/runtimes/antigravity/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ') ;;
      opencode)    count=$(find "$JDI_ROOT/runtimes/opencode/agents" -name "*.md" 2>/dev/null | wc -l | tr -d ' ') ;;
      *)           count=0 ;;
    esac

    if [[ "$count" -gt 0 ]]; then
      ok "runtimes/$rt buildado ($count agents/skills)"
    else
      warn "runtimes/$rt vazio. Rode: ./bin/jdi-build.sh"
    fi
  else
    warn "runtimes/$rt ausente. Rode: ./bin/jdi-build.sh"
  fi
done

# ---------------------------------------------------------------------------
section "6. Projeto atual ($PROJECT_DIR)"

if [[ "$PROJECT_DIR" == "$JDI_ROOT" ]]; then
  note "Voce esta no proprio repo do JDI. Rode jdi-doctor de dentro do seu projeto pra checar install."
fi

if [[ -d "$PROJECT_DIR/.jdi" ]]; then
  ok "projeto eh JDI (.jdi/ existe)"

  for f in PROJECT.md ROADMAP.md STATE.md; do
    if [[ -f "$PROJECT_DIR/.jdi/$f" ]]; then
      ok ".jdi/$f presente"
    else
      warn ".jdi/$f ausente. /jdi-new nao completou ou foi removido."
    fi
  done

  for f in DECISIONS.md specialists.md reviewers.md registry.md todos.md; do
    [[ -f "$PROJECT_DIR/.jdi/$f" ]] && ok ".jdi/$f presente" || note ".jdi/$f ausente (criado on-demand)"
  done

  if [[ -d "$PROJECT_DIR/.jdi/agents" ]]; then
    spec_count=$(find "$PROJECT_DIR/.jdi/agents" -name "jdi-doer-*.md" -o -name "jdi-reviewer-*.md" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$spec_count" -gt 0 ]]; then
      ok ".jdi/agents/ com $spec_count specialist(s) per-project"
    else
      note ".jdi/agents/ vazio (rode /jdi-bootstrap pra criar specialists)"
    fi
  fi

  if [[ -d "$PROJECT_DIR/.jdi/phases" ]]; then
    PHASE_COUNT=$(find "$PROJECT_DIR/.jdi/phases" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
    ok ".jdi/phases/ com $PHASE_COUNT phase(s)"
  fi

  CFG="$PROJECT_DIR/.jdi/config.json"
  if [[ -f "$CFG" ]]; then
    # "mode" only appears in the orchestration block — unambiguous via grep (jq optional)
    OMODE=$(grep -oE '"mode"[[:space:]]*:[[:space:]]*"(standard|enhanced)"' "$CFG" 2>/dev/null | grep -oE '(standard|enhanced)' | head -1)
    [[ -z "$OMODE" ]] && OMODE=standard
    if [[ "$OMODE" == "enhanced" ]]; then
      ok ".jdi/config.json orchestration: enhanced (advisory multi-agent layers opt-in; degrade when host cannot fan out)"
    else
      note ".jdi/config.json orchestration: standard (single-agent path)"
    fi
  fi
else
  warn ".jdi/ ausente. Rode /jdi-new ou esta fora de um projeto JDI."
fi

# ---------------------------------------------------------------------------
section "7. Runtime instalado no projeto"

INSTALL_FOUND=false

if [[ -d "$PROJECT_DIR/.claude/agents" ]]; then
  count=$(find "$PROJECT_DIR/.claude/agents" -name "$JDI_AGENT_GLOB" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    ok ".claude/agents/ com $count agents JDI"
    INSTALL_FOUND=true
  else
    warn ".claude/agents/ existe mas sem agents JDI. Rode jdi-install.sh"
  fi
fi

if [[ -d "$PROJECT_DIR/.github/agents" ]]; then
  count=$(find "$PROJECT_DIR/.github/agents" -name "jdi-*.agent.md" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    ok ".github/agents/ com $count agents JDI"
    INSTALL_FOUND=true
  fi
fi

if [[ -d "$PROJECT_DIR/.github/skills" ]]; then
  count=$(find "$PROJECT_DIR/.github/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    ok ".github/skills/ com $count skills JDI (Copilot CLI + coding agent)"
    INSTALL_FOUND=true
  fi
elif [[ -d "$PROJECT_DIR/.github/prompts" ]] && ls "$PROJECT_DIR/.github/prompts"/jdi-*.prompt.md >/dev/null 2>&1; then
  warn ".github/prompts/ presente mas .github/skills/ ausente — Copilot CLI nao le prompts; rode 'jdi install copilot' de novo (>=0.10.0)"
fi

if [[ -d "$PROJECT_DIR/.agents/skills" ]]; then
  count=$(find "$PROJECT_DIR/.agents/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    ok ".agents/skills/ com $count skills JDI (Antigravity 2.0)"
    INSTALL_FOUND=true
  fi
fi

if [[ -d "$PROJECT_DIR/.gemini/antigravity/skills" ]]; then
  count=$(find "$PROJECT_DIR/.gemini/antigravity/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    warn ".gemini/antigravity/skills/ com $count skills JDI (1.x legado — o 2.0 nao le; 'jdi update' migra)"
    INSTALL_FOUND=true
  fi
fi

if [[ -d "$PROJECT_DIR/.junie/skills" ]]; then
  count=$(find "$PROJECT_DIR/.junie/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    ok ".junie/skills/ com $count skills JDI"
    INSTALL_FOUND=true
  fi
fi

if [[ -d "$PROJECT_DIR/.opencode/agents" ]]; then
  count=$(find "$PROJECT_DIR/.opencode/agents" -name "$JDI_AGENT_GLOB" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    ok ".opencode/agents/ com $count agents JDI"
    INSTALL_FOUND=true
  fi
fi

if [[ -d "$HOME/.claude/agents" ]]; then
  count=$(find "$HOME/.claude/agents" -name "$JDI_AGENT_GLOB" 2>/dev/null | wc -l | tr -d ' ')
  [[ "$count" -gt 0 ]] && ok "~/.claude/agents/ com $count agents JDI (scope user)" && INSTALL_FOUND=true
fi

if [[ -d "$HOME/.config/opencode/agents" ]]; then
  count=$(find "$HOME/.config/opencode/agents" -name "$JDI_AGENT_GLOB" 2>/dev/null | wc -l | tr -d ' ')
  [[ "$count" -gt 0 ]] && ok "~/.config/opencode/agents/ com $count agents JDI (scope user)" && INSTALL_FOUND=true
fi

if ! $INSTALL_FOUND && [[ -d "$PROJECT_DIR/.jdi" ]]; then
  fail "Projeto eh JDI mas nenhum runtime instalado. Rode: $JDI_ROOT/bin/jdi-install.sh <runtime>"
fi

# ---------------------------------------------------------------------------
section "8. Git hooks"

if [[ -f "$PROJECT_DIR/.githooks/pre-commit" ]]; then
  if [[ -x "$PROJECT_DIR/.githooks/pre-commit" ]]; then
    ok ".githooks/pre-commit existe e executavel"
  else
    warn ".githooks/pre-commit nao executavel. Rode: chmod +x .githooks/pre-commit"
  fi

  HOOKS_PATH=$(git -C "$PROJECT_DIR" config core.hooksPath 2>/dev/null || echo "")
  if [[ "$HOOKS_PATH" == ".githooks" || "$HOOKS_PATH" == "$PROJECT_DIR/.githooks" ]]; then
    ok "git core.hooksPath aponta pra .githooks"
  else
    warn "git core.hooksPath nao configurado. Rode: git config core.hooksPath .githooks"
  fi
elif [[ -d "$PROJECT_DIR/.jdi" ]]; then
  warn ".githooks/ ausente em projeto JDI. Rode jdi-install.sh pra instalar."
fi

# ---------------------------------------------------------------------------
section "9. Repo git limpo (recomendado pra /jdi-create)"

if git -C "$PROJECT_DIR" rev-parse --git-dir &>/dev/null; then
  if git -C "$PROJECT_DIR" diff-index --quiet HEAD -- 2>/dev/null; then
    ok "working tree limpo"
  else
    note "working tree com mudancas (ok pra /jdi-do, mas commit antes de /jdi-create)"
  fi
else
  warn "Diretorio nao eh repo git. /jdi-new e atomic commits nao funcionam sem git."
fi

# ---------------------------------------------------------------------------
section "10. Playwright + MCP (optional)"

if [[ -f "$PROJECT_DIR/package.json" ]] && grep -q '"@playwright/test"' "$PROJECT_DIR/package.json" 2>/dev/null; then
  ok "@playwright/test in package.json"
else
  note "@playwright/test not installed (run: npx jdi-cli install-playwright)"
fi

if [[ -f "$PROJECT_DIR/.claude/settings.local.json" ]]; then
  if grep -q "$PLAYWRIGHT_KEY" "$PROJECT_DIR/.claude/settings.local.json" 2>/dev/null; then
    ok "Claude Code MCP playwright configured"
  else
    note "Claude Code settings.local.json present but no MCP playwright entry"
  fi
fi

if [[ -f "$PROJECT_DIR/.opencode/opencode.jsonc" ]]; then
  if grep -q "$PLAYWRIGHT_KEY" "$PROJECT_DIR/.opencode/opencode.jsonc" 2>/dev/null; then
    ok "OpenCode MCP playwright configured"
  else
    note "OpenCode opencode.jsonc present but no MCP playwright entry"
  fi
fi

if [[ -f "$PROJECT_DIR/.vscode/mcp.json" ]]; then
  if grep -q "$PLAYWRIGHT_KEY" "$PROJECT_DIR/.vscode/mcp.json" 2>/dev/null; then
    ok "Copilot (VS Code) MCP playwright configured"
  else
    note ".vscode/mcp.json present but no playwright entry"
  fi
fi

if [[ -f "$HOME/.gemini/config/mcp_config.json" ]] && grep -q "$PLAYWRIGHT_KEY" "$HOME/.gemini/config/mcp_config.json" 2>/dev/null; then
  ok "Antigravity 2.0 MCP playwright configured (~/.gemini/config/mcp_config.json)"
elif [[ -f "$HOME/.gemini/settings.json" ]] && grep -q "$PLAYWRIGHT_KEY" "$HOME/.gemini/settings.json" 2>/dev/null; then
  ok "Antigravity 1.x MCP playwright configured (user scope settings.json)"
elif [[ -f "$PROJECT_DIR/.gemini/settings.json" ]] && grep -q "$PLAYWRIGHT_KEY" "$PROJECT_DIR/.gemini/settings.json" 2>/dev/null; then
  ok "Antigravity MCP playwright configured (project scope)"
fi

# ---------------------------------------------------------------------------
section "11. Specialists (single vs multi-stack)"

SPEC_PATH="$PROJECT_DIR/.jdi/specialists.md"
REV_PATH="$PROJECT_DIR/.jdi/reviewers.md"

if [[ -f "$SPEC_PATH" ]]; then
  DOERS=$(grep -oE 'jdi-doer-[a-z0-9-]+' "$SPEC_PATH" | sort -u)
  DOER_COUNT=$(echo "$DOERS" | grep -c .)
  if [[ "$DOER_COUNT" -eq 0 ]]; then
    note "specialists.md exists but no doer registered"
  elif [[ "$DOER_COUNT" -eq 1 ]]; then
    ok "Single-stack: $DOERS"
  else
    ok "Multi-stack: $DOER_COUNT doer specialists"
    echo "$DOERS" | while read d; do note "  - $d"; done
  fi
else
  note ".jdi/specialists.md missing (run /jdi-bootstrap)"
fi

if [[ -f "$REV_PATH" ]]; then
  REVS=$(grep -oE 'jdi-reviewer-[a-z0-9-]+' "$REV_PATH" | sort -u | wc -l)
  if [[ "$REVS" -gt 1 ]]; then
    note "  Reviewer chain length: $REVS (multi-stack /jdi-verify)"
  fi
fi

# ---------------------------------------------------------------------------
section "12. Caveman plugin (optional)"

CAVEMAN_USER="$HOME/.claude/plugins/caveman"
CAVEMAN_PROJECT="$PROJECT_DIR/.claude/plugins/caveman"

if [[ -d "$CAVEMAN_USER" ]]; then
  ok "Caveman installed (user scope: $CAVEMAN_USER)"
elif [[ -d "$CAVEMAN_PROJECT" ]]; then
  ok "Caveman installed (project scope: $CAVEMAN_PROJECT)"
else
  note "Caveman plugin not installed (run: npx jdi-cli install-caveman)"
fi

# ---------------------------------------------------------------------------
section "13. Coding agent (issues delegadas — Copilot)"

GH_DIR="$PROJECT_DIR/.github"
if [[ -d "$GH_DIR/agents" || -d "$GH_DIR/prompts" ]]; then
  if [[ -f "$GH_DIR/agents/jdi-solo.agent.md" ]]; then
    ok "persona jdi-solo presente (.github/agents/jdi-solo.agent.md)"
  else
    warn "jdi-solo ausente — sessao delegada seleciona persona errada (rode: npx jdi-cli update ou install copilot)"
  fi

  if [[ -f "$GH_DIR/workflows/copilot-setup-steps.yml" ]]; then
    ok "copilot-setup-steps.yml presente (hooks + node na sessao do agente)"
  else
    note "copilot-setup-steps.yml ausente (install copilot copia; precisa estar na default branch)"
  fi

  if [[ -f "$GH_DIR/workflows/jdi-artifacts-gate.yml" ]]; then
    ok "jdi-artifacts-gate.yml presente (gate de PR copilot/*)"
  else
    note "jdi-artifacts-gate.yml ausente — PR de agente sem artefatos passa despercebido"
  fi

  HOOK="$PROJECT_DIR/.githooks/pre-commit"
  if [[ -f "$HOOK" ]] && grep -q "JDI GATE" "$HOOK" 2>/dev/null; then
    if [[ -x "$HOOK" ]]; then
      ok "pre-commit com gate de artefatos em .githooks/ (executavel)"
    else
      # git ignora hook nao-executavel SILENCIOSAMENTE — o gate fica off sem erro
      warn "pre-commit em .githooks/ NAO e executavel — git o ignora em silencio. Fix: chmod +x .githooks/*"
    fi
  else
    note "gate pre-commit ausente em .githooks/ (install copilot --githooks)"
  fi
else
  note "runtime copilot nao instalado no projeto — secao pulada"
fi

# ---------------------------------------------------------------------------
section "Resumo"

if [[ "$FAILS" -gt 0 ]]; then
  echo "  ${RED}${FAILS} FAIL${RST}, ${YLW}${WARNS} WARN${RST}"
  echo "  -> Resolva os FAIL antes de usar JDI."
  exit 1
elif [[ "$WARNS" -gt 0 ]]; then
  echo "  ${YLW}${WARNS} WARN${RST} (JDI funciona mas com limitacoes)"
  exit 0
else
  echo "  ${GRN}Tudo OK${RST}. JDI pronto pra rodar."
  exit 0
fi
