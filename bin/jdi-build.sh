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

ensure_dirs() {
  mkdir -p "${OUT}/claude/agents" "${OUT}/claude/commands" "${OUT}/claude/skills"
  mkdir -p "${OUT}/copilot/agents" "${OUT}/copilot/prompts"
  mkdir -p "${OUT}/antigravity/skills"
  mkdir -p "${OUT}/opencode/agents" "${OUT}/opencode/commands" "${OUT}/opencode/skills"
}

# extrai bloco `runtime_overrides.<runtime>` do frontmatter e gera frontmatter
# alvo no formato do runtime correspondente. parser simples (depth-aware).
build_claude_agent() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  local dst="${OUT}/claude/agents/${name}.md"

  awk -v name="$name" '
    BEGIN { in_fm=0; print_after_fm=1 }
    /^---$/ {
      if (in_fm == 0) { in_fm=1; print "---"; print "name: " name; next }
      else { in_fm=0; print "---"; next }
    }
    in_fm == 1 {
      if ($0 ~ /^description:/) print
      else if ($0 ~ /^[[:space:]]*tools:[[:space:]]*\[/) {
        # captura tools claude do override
        next
      }
      next
    }
    { print }
  ' "$src" > "$dst"

  # extrai claude tools/model do override
  # range explicito por indent: ativa em "  claude:" (2 spaces), desativa em proxima chave de 2 spaces
  local claude_tools claude_model
  claude_tools=$(awk '/^  claude:/{f=1;next} f && /^  [a-z]+:/{f=0} f' "$src" | grep -E "^[[:space:]]+tools:" | head -1 | sed 's/^[[:space:]]*tools:[[:space:]]*//' || true)
  claude_model=$(awk '/^  claude:/{f=1;next} f && /^  [a-z]+:/{f=0} f' "$src" | grep -E "^[[:space:]]+model:" | head -1 | sed 's/^[[:space:]]*model:[[:space:]]*//' || true)

  # injeta tools e model no frontmatter alvo (apos description)
  if [[ -n "$claude_tools" ]]; then
    sed -i "/^description:/a tools: ${claude_tools}" "$dst"
  fi
  if [[ -n "$claude_model" ]]; then
    sed -i "/^description:/a model: ${claude_model}" "$dst"
  fi

  echo "  claude/agents/${name}.md"
}

build_copilot_agent() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  local dst="${OUT}/copilot/agents/${name}.agent.md"

  # mesmo principio, mas usa runtime_overrides.copilot
  awk '
    BEGIN { in_fm=0 }
    /^---$/ {
      if (in_fm==0) { in_fm=1; print; next } else { in_fm=0; print; next }
    }
    in_fm==1 && ($0 ~ /^name:|^description:/) { print; next }
    in_fm==1 { next }
    { print }
  ' "$src" > "$dst"

  local copilot_tools copilot_model
  copilot_tools=$(awk '/^  copilot:/{f=1;next} f && /^  [a-z]+:/{f=0} f' "$src" | grep -E "^[[:space:]]+tools:" | head -1 | sed 's/^[[:space:]]*tools:[[:space:]]*//' || true)
  copilot_model=$(awk '/^  copilot:/{f=1;next} f && /^  [a-z]+:/{f=0} f' "$src" | grep -E "^[[:space:]]+model:" | head -1 | sed 's/^[[:space:]]*model:[[:space:]]*//' || true)

  [[ -n "$copilot_tools" ]] && sed -i "/^description:/a tools: ${copilot_tools}" "$dst"
  [[ -n "$copilot_model" ]] && sed -i "/^description:/a model: ${copilot_model}" "$dst"

  echo "  copilot/agents/${name}.agent.md"
}

build_antigravity_skill() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  local skill_dir="${OUT}/antigravity/skills/${name}"
  local dst="${skill_dir}/SKILL.md"

  mkdir -p "$skill_dir/references" "$skill_dir/scripts"

  # mantem frontmatter + corpo. agrega triggers do runtime_overrides.antigravity.triggers_extra
  awk '
    BEGIN { in_fm=0; in_overrides=0 }
    /^---$/ {
      if (in_fm==0) { in_fm=1; print; next } else { in_fm=0; print; next }
    }
    in_fm==1 && ($0 ~ /^name:|^description:|^triggers:/) { print; next }
    in_fm==1 && ($0 ~ /^[[:space:]]*-/) {
      # eh continuacao de triggers. mantem
      print; next
    }
    in_fm==1 { next }
    { print }
  ' "$src" > "$dst"

  # append triggers_extra do antigravity override em "triggers:" se existir
  local extras
  extras=$(awk '/^[[:space:]]*antigravity:/,/^[[:space:]]*[a-z]+:/' "$src" \
    | awk '/triggers_extra:/,/^[[:space:]]*[a-z_]+:/' \
    | grep -E '^[[:space:]]*-[[:space:]]+"' \
    | sed 's/^[[:space:]]*/  /' || true)

  if [[ -n "$extras" ]]; then
    # injeta sob "triggers:"
    awk -v extras="$extras" '
      /^triggers:/ { print; print extras; next }
      { print }
    ' "$dst" > "${dst}.tmp" && mv "${dst}.tmp" "$dst"
  fi

  echo "  antigravity/skills/${name}/SKILL.md"
}

build_opencode_agent() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  local dst="${OUT}/opencode/agents/${name}.md"

  # OpenCode usa frontmatter proprio (description, mode, model, temperature, permission)
  awk '
    BEGIN { in_fm=0 }
    /^---$/ {
      if (in_fm==0) { in_fm=1; print; next } else { in_fm=0; print; next }
    }
    in_fm==1 && ($0 ~ /^description:/) { print; next }
    in_fm==1 { next }
    { print }
  ' "$src" > "$dst"

  # Extrai bloco opencode do override
  local oc_block
  oc_block=$(awk '/^[[:space:]]*opencode:/,/^[[:space:]]{2}[a-z]+:|^---/' "$src" \
    | grep -E '^[[:space:]]+(mode|model|temperature|permission):' \
    | sed 's/^[[:space:]]\{4\}//' || true)

  # permission tem sub-keys, precisa preservar indentacao maior
  local perm_block
  perm_block=$(awk '/^[[:space:]]*opencode:/,/^[[:space:]]{2}[a-z]+:|^---/' "$src" \
    | awk '/permission:/,/^[[:space:]]{4}[a-z]+:|^[[:space:]]{2}[a-z]+:|^---/' \
    | sed 's/^[[:space:]]\{4\}//' || true)

  # injeta tudo apos description:
  if [[ -n "$oc_block" ]]; then
    awk -v block="$oc_block" '
      /^description:/ { print; print block; next }
      { print }
    ' "$dst" > "${dst}.tmp" && mv "${dst}.tmp" "$dst"
  fi

  echo "  opencode/agents/${name}.md"
}

build_command() {
  local src="$1"
  local name; name=$(basename "$src" .md)

  # claude: commands/<name>.md (mesmo formato + frontmatter ajustado)
  cp "$src" "${OUT}/claude/commands/${name}.md"

  # copilot: prompts/<name>.prompt.md (mode: agent + ajustes)
  cp "$src" "${OUT}/copilot/prompts/${name}.prompt.md"

  # antigravity: skills/<name>/SKILL.md
  local skill_dir="${OUT}/antigravity/skills/${name}"
  mkdir -p "$skill_dir/scripts"
  cp "$src" "${skill_dir}/SKILL.md"

  # opencode: commands/<name>.md (formato proprio com agent: e subtask:)
  cp "$src" "${OUT}/opencode/commands/${name}.md"

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

    if [[ "$runtime" == "antigravity" ]]; then
      # Antigravity descobre skills por triggers - extrai runtime_overrides.antigravity.triggers
      local triggers
      triggers=$(awk '
        /^[[:space:]]*antigravity:/ { in_ag=1; next }
        in_ag && /^[[:space:]]{2}[a-z_]+:/ { exit }
        in_ag && /^[[:space:]]+triggers:/ { in_tr=1; next }
        in_ag && in_tr && /^[[:space:]]+-[[:space:]]+/ { print "  " $0; next }
        in_ag && in_tr && /^[[:space:]]+[a-z_]+:/ { exit }
      ' "$src_skill" | sed 's/^[[:space:]]*-[[:space:]]\+/  - /')

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

  if [[ "$TARGET" == "claude" || "$TARGET" == "all" ]]; then
    echo
    echo "claude:"
    for f in "$CORE"/agents/*.md; do
      build_claude_agent "$f"
    done
  fi

  if [[ "$TARGET" == "copilot" || "$TARGET" == "all" ]]; then
    echo
    echo "copilot:"
    for f in "$CORE"/agents/*.md; do
      build_copilot_agent "$f"
    done
  fi

  if [[ "$TARGET" == "antigravity" || "$TARGET" == "all" ]]; then
    echo
    echo "antigravity:"
    for f in "$CORE"/agents/*.md; do
      build_antigravity_skill "$f"
    done
  fi

  if [[ "$TARGET" == "opencode" || "$TARGET" == "all" ]]; then
    echo
    echo "opencode:"
    for f in "$CORE"/agents/*.md; do
      build_opencode_agent "$f"
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

      if [[ "$TARGET" == "claude" || "$TARGET" == "all" ]]; then
        build_standalone_skill "$skill_dir" "claude" "${OUT}/claude/skills/${skill_name}"
      fi
      if [[ "$TARGET" == "opencode" || "$TARGET" == "all" ]]; then
        build_standalone_skill "$skill_dir" "opencode" "${OUT}/opencode/skills/${skill_name}"
      fi
      if [[ "$TARGET" == "antigravity" || "$TARGET" == "all" ]]; then
        build_standalone_skill "$skill_dir" "antigravity" "${OUT}/antigravity/skills/${skill_name}"
      fi
      # Copilot: nao tem conceito nativo de skill - skip
    done
  fi

  echo
  echo "Build completo. Veja runtimes/$TARGET/"
}

main
