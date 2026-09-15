#!/usr/bin/env bash
# jdi-build: gera runtimes/{claude,copilot,antigravity} a partir de core/.
# Uso: ./bin/jdi-build.sh [runtime]
#   runtime: claude | copilot | antigravity | all (default)
#
# Requer: bash, sed, awk, mkdir.
# Nao requer yq nem jq — parser inline simples.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="${ROOT}/core"
OUT="${ROOT}/runtimes"
TARGET="${1:-all}"
# Frontmatter parsing + per-runtime emitters live in the shared lib (also
# used by jdi-sync-specialists.sh for .jdi/agents/ -> runtime dirs, #33);
# the runtime-name constants (RT_*, ANTIGRAVITY, K_DESC) come from it too.
# shellcheck source=lib/jdi-agent-emit.sh
source "${ROOT}/bin/lib/jdi-agent-emit.sh"

ensure_dirs() {
  mkdir -p "${OUT}/claude/agents" "${OUT}/claude/commands" "${OUT}/claude/skills"
  mkdir -p "${OUT}/copilot/agents" "${OUT}/copilot/prompts" "${OUT}/copilot/skills"
  mkdir -p "${OUT}/antigravity/skills"
  mkdir -p "${OUT}/opencode/agents" "${OUT}/opencode/commands" "${OUT}/opencode/skills"
  mkdir -p "${OUT}/junie/agents" "${OUT}/junie/skills"
}

build_claude_agent() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  emit_agent "$RT_CLAUDE" "$src" "${OUT}/claude/agents/${name}.md"
  echo "  claude/agents/${name}.md"
}

build_copilot_agent() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  emit_agent "$RT_COPILOT" "$src" "${OUT}/copilot/agents/${name}.agent.md"
  echo "  copilot/agents/${name}.agent.md"
}

build_antigravity_skill() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  local skill_dir="${OUT}/antigravity/skills/${name}"
  mkdir -p "$skill_dir/references" "$skill_dir/scripts"
  emit_agent "$ANTIGRAVITY" "$src" "${skill_dir}/SKILL.md"
  echo "  antigravity/skills/${name}/SKILL.md"
}

build_opencode_agent() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  emit_agent "$RT_OPENCODE" "$src" "${OUT}/opencode/agents/${name}.md"
  echo "  opencode/agents/${name}.md"
}

build_junie_agent() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  emit_agent "$RT_JUNIE" "$src" "${OUT}/junie/agents/${name}.md"
  echo "  junie/agents/${name}.md"
}

build_command() {
  local src="$1"
  local name; name=$(basename "$src" .md)

  # claude: commands/<name>.md (mesmo formato + frontmatter ajustado)
  cp "$src" "${OUT}/claude/commands/${name}.md"

  # copilot: prompts/<name>.prompt.md (VS Code slash) + skills/<name>/SKILL.md
  # (Copilot CLI + cloud agent: Agent Skills GA Apr/2026 — the CLI does NOT
  # read .github/prompts/, so skills are the CLI's discovery path)
  cp "$src" "${OUT}/copilot/prompts/${name}.prompt.md"
  local copilot_skill_dir="${OUT}/copilot/skills/${name}"
  mkdir -p "$copilot_skill_dir"
  cp "$src" "${copilot_skill_dir}/SKILL.md"

  # antigravity: skills/<name>/SKILL.md
  local skill_dir="${OUT}/antigravity/skills/${name}"
  mkdir -p "$skill_dir/scripts"
  cp "$src" "${skill_dir}/SKILL.md"

  # opencode: commands/<name>.md (formato proprio com agent: e subtask:)
  cp "$src" "${OUT}/opencode/commands/${name}.md"

  # junie: skills/<name>/SKILL.md (semantic discovery — NOT a custom command:
  # Junie template args would treat the body's $VARS as required parameters)
  local junie_skill_dir="${OUT}/junie/skills/${name}"
  mkdir -p "$junie_skill_dir"
  cp "$src" "${junie_skill_dir}/SKILL.md"

  echo "  command: ${name}"
}

# Standalone skill em core/skills/<name>/SKILL.md (com optional references/ + scripts/).
# Diferente de build_antigravity_skill, que converte agent em skill - aqui a skill ja eh skill.
build_standalone_skill() {
  local src_dir="$1"
  local runtime="$2"
  local dest_root="$3"

  local name; name=$(basename "$src_dir")
  local src_skill="${src_dir}/SKILL.md"

  [[ ! -f "$src_skill" ]] && return 0

  mkdir -p "$dest_root"

  # Le description do frontmatter base
  local desc
  desc=$(awk '
    BEGIN { in_fm=0 }
    /^---$/ { if (in_fm==0) { in_fm=1; next } else { exit } }
    in_fm==1 && /^description:/ {
      sub(/^description:[[:space:]]*/, "")
      print
      exit
    }
  ' "$src_skill")

  # Constroi frontmatter alvo + body
  {
    echo "---"
    echo "name: ${name}"
    [[ -n "$desc" ]] && echo "description: ${desc}"

    if [[ "$runtime" == "$ANTIGRAVITY" ]]; then
      # Antigravity descobre skills por triggers - extrai runtime_overrides.antigravity.triggers
      local triggers
      triggers=$(override_block "$src_skill" "antigravity" "triggers")

      if [[ -n "$triggers" ]]; then
        echo "triggers:"
        echo "$triggers"
      fi
    fi

    echo "---"

    # Body apos segundo ---
    awk '
      BEGIN { in_fm=0 }
      /^---$/ {
        if (in_fm==0) { in_fm=1; next }
        else if (in_fm==1) { in_fm=2; next }
      }
      in_fm==2 { print }
    ' "$src_skill"
  } > "${dest_root}/SKILL.md"

  # Copia subdirs opcionais
  for subdir in references scripts; do
    if [[ -d "${src_dir}/${subdir}" ]]; then
      rm -rf "${dest_root}/${subdir}"
      cp -r "${src_dir}/${subdir}" "${dest_root}/"
    fi
  done

  echo "  ${runtime}/skills/${name}/SKILL.md"
}

main() {
  ensure_dirs

  echo "JDI build — gerando runtimes a partir de core/"

  if [[ "$TARGET" == "$RT_CLAUDE" || "$TARGET" == "all" ]]; then
    echo
    echo "claude:"
    for f in "$CORE"/agents/*.md; do
      build_claude_agent "$f"
    done
  fi

  if [[ "$TARGET" == "$RT_COPILOT" || "$TARGET" == "all" ]]; then
    echo
    echo "copilot:"
    for f in "$CORE"/agents/*.md; do
      build_copilot_agent "$f"
    done
  fi

  if [[ "$TARGET" == "$ANTIGRAVITY" || "$TARGET" == "all" ]]; then
    echo
    echo "antigravity:"
    for f in "$CORE"/agents/*.md; do
      build_antigravity_skill "$f"
    done
  fi

  if [[ "$TARGET" == "$RT_OPENCODE" || "$TARGET" == "all" ]]; then
    echo
    echo "opencode:"
    for f in "$CORE"/agents/*.md; do
      build_opencode_agent "$f"
    done
  fi

  if [[ "$TARGET" == "$RT_JUNIE" || "$TARGET" == "all" ]]; then
    echo
    echo "junie:"
    for f in "$CORE"/agents/*.md; do
      build_junie_agent "$f"
    done
  fi

  echo
  echo "commands (todos os runtimes):"
  for f in "$CORE"/commands/*.md; do
    build_command "$f"
  done

  # Standalone skills em core/skills/<name>/SKILL.md
  if [[ -d "$CORE/skills" ]] && [[ -n "$(ls -A "$CORE/skills" 2>/dev/null)" ]]; then
    echo
    echo "skills (standalone):"
    for skill_dir in "$CORE"/skills/*/; do
      [[ ! -d "$skill_dir" ]] && continue
      skill_name=$(basename "$skill_dir")

      if [[ "$TARGET" == "$RT_CLAUDE" || "$TARGET" == "all" ]]; then
        build_standalone_skill "$skill_dir" "$RT_CLAUDE" "${OUT}/claude/skills/${skill_name}"
      fi
      if [[ "$TARGET" == "$RT_OPENCODE" || "$TARGET" == "all" ]]; then
        build_standalone_skill "$skill_dir" "$RT_OPENCODE" "${OUT}/opencode/skills/${skill_name}"
      fi
      if [[ "$TARGET" == "$ANTIGRAVITY" || "$TARGET" == "all" ]]; then
        build_standalone_skill "$skill_dir" "$ANTIGRAVITY" "${OUT}/antigravity/skills/${skill_name}"
      fi
      if [[ "$TARGET" == "$RT_JUNIE" || "$TARGET" == "all" ]]; then
        build_standalone_skill "$skill_dir" "$RT_JUNIE" "${OUT}/junie/skills/${skill_name}"
      fi
      if [[ "$TARGET" == "$RT_COPILOT" || "$TARGET" == "all" ]]; then
        build_standalone_skill "$skill_dir" "$RT_COPILOT" "${OUT}/copilot/skills/${skill_name}"
      fi
    done
  fi

  echo
  echo "Build completo. Veja runtimes/$TARGET/"
}

main
