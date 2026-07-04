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
# Repeated literals extracted to constants (S1192)
readonly ANTIGRAVITY="antigravity"
readonly RT_CLAUDE="$RT_CLAUDE"
readonly RT_OPENCODE="$RT_OPENCODE"
readonly K_DESC="description"

ensure_dirs() {
  mkdir -p "${OUT}/claude/agents" "${OUT}/claude/commands" "${OUT}/claude/skills"
  mkdir -p "${OUT}/copilot/agents" "${OUT}/copilot/prompts"
  mkdir -p "${OUT}/antigravity/skills"
  mkdir -p "${OUT}/opencode/agents" "${OUT}/opencode/commands" "${OUT}/opencode/skills"
}

# ---------------------------------------------------------------------------
# Parsing helpers — frontmatter-bounded, mirror jdi-build.ps1 1:1.
#
# The old builders used awk /start/,/end/ ranges whose end pattern also
# matched the start line (single-line range → empty extraction) and a
# frontmatter toggle that re-entered on `---` horizontal rules in the body
# (truncated agents). Every helper below hard-stops at the closing `---`.
# ---------------------------------------------------------------------------

# Everything after the closing `---` of the frontmatter (body verbatim,
# including any `---` horizontal rules inside it).
extract_body() {
  local file="$1"
  awk '
    fm >= 2 { print; next }
    /^---$/ { fm++ }
  ' "$file"
}

# Scalar value of a top-level frontmatter key (e.g. description).
base_fm_value() {
  local file="$1" key="$2"
  awk -v key="$key" '
    /^---$/ { fm++; if (fm == 2) exit; next }
    fm == 1 && index($0, key ":") == 1 {
      sub("^" key ":[[:space:]]*", ""); print; exit
    }
  ' "$file"
}

# Multiline block of a top-level frontmatter key (key line + indented lines).
base_fm_block() {
  local file="$1" key="$2"
  awk -v key="$key" '
    /^---$/ { fm++; if (fm == 2) exit; next }
    fm == 1 && $0 == key ":" { b = 1; print; next }
    b && /^[^ \t]/ { b = 0 }
    b && /^[[:space:]]+[^ \t]/ { print }
  ' "$file"
}

# Scalar under runtime_overrides.<runtime> (4-space keys).
override_scalar() {
  local file="$1" rt="$2" key="$3"
  awk -v rt="$rt" -v key="$key" '
    /^---$/ { fm++; if (fm == 2) exit; next }
    fm == 1 && $0 == "  " rt ":" { r = 1; next }
    r && /^  [a-z_-]+:/ { r = 0 }
    r && index($0, "    " key ":") == 1 {
      sub("^    " key ":[[:space:]]*", ""); print; exit
    }
  ' "$file"
}

# Sub-block under runtime_overrides.<runtime>.<subkey>: emits the 6-space
# child lines re-indented to 2 spaces (same as the ps1 SubBlocks strip).
override_block() {
  local file="$1" rt="$2" sub_key="$3"
  awk -v rt="$rt" -v sub_key="$sub_key" '
    /^---$/ { fm++; if (fm == 2) exit; next }
    fm == 1 && $0 == "  " rt ":" { r = 1; next }
    r && /^  [a-z_-]+:/ { r = 0 }
    r && $0 == "    " sub_key ":" { b = 1; next }
    b && /^    [a-z_]+:/ { b = 0 }
    b && /^[[:space:]]*-[[:space:]]+/ { sub(/^[[:space:]]*/, "  "); print; next }
    b && /^      / { sub(/^[[:space:]]{6}/, "  "); print }
  ' "$file"
}

build_claude_agent() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  local dst="${OUT}/claude/agents/${name}.md"

  local desc model tools
  desc=$(base_fm_value "$src" "$K_DESC")
  model=$(override_scalar "$src" "$RT_CLAUDE" "model")
  tools=$(override_scalar "$src" "$RT_CLAUDE" "tools")

  {
    echo "---"
    echo "name: ${name}"
    [[ -n "$desc" ]] && echo "description: ${desc}"
    [[ -n "$model" ]] && echo "model: ${model}"
    [[ -n "$tools" ]] && echo "tools: ${tools}"
    echo "---"
    extract_body "$src"
  } > "$dst"

  echo "  claude/agents/${name}.md"
}

build_copilot_agent() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  local dst="${OUT}/copilot/agents/${name}.agent.md"

  local desc model tools
  desc=$(base_fm_value "$src" "$K_DESC")
  model=$(override_scalar "$src" "copilot" "model")
  tools=$(override_scalar "$src" "copilot" "tools")

  {
    echo "---"
    echo "name: ${name}"
    [[ -n "$desc" ]] && echo "description: ${desc}"
    [[ -n "$model" ]] && echo "model: ${model}"
    [[ -n "$tools" ]] && echo "tools: ${tools}"
    echo "---"
    extract_body "$src"
  } > "$dst"

  echo "  copilot/agents/${name}.agent.md"
}

build_antigravity_skill() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  local skill_dir="${OUT}/antigravity/skills/${name}"
  local dst="${skill_dir}/SKILL.md"

  mkdir -p "$skill_dir/references" "$skill_dir/scripts"

  local desc triggers_block extras
  desc=$(base_fm_value "$src" "$K_DESC")
  triggers_block=$(base_fm_block "$src" "triggers")
  extras=$(override_block "$src" "antigravity" "triggers_extra")

  {
    echo "---"
    echo "name: ${name}"
    [[ -n "$desc" ]] && echo "description: ${desc}"
    if [[ -n "$triggers_block" ]]; then
      echo "$triggers_block"
      [[ -n "$extras" ]] && echo "$extras"
    fi
    echo "---"
    extract_body "$src"
  } > "$dst"

  echo "  antigravity/skills/${name}/SKILL.md"
}

build_opencode_agent() {
  local src="$1"
  local name; name=$(basename "$src" .md)
  local dst="${OUT}/opencode/agents/${name}.md"

  local desc mode model temperature perm
  desc=$(base_fm_value "$src" "$K_DESC")
  mode=$(override_scalar "$src" "$RT_OPENCODE" "mode")
  model=$(override_scalar "$src" "$RT_OPENCODE" "model")
  temperature=$(override_scalar "$src" "$RT_OPENCODE" "temperature")
  perm=$(override_block "$src" "$RT_OPENCODE" "permission")

  {
    echo "---"
    [[ -n "$desc" ]] && echo "description: ${desc}"
    [[ -n "$mode" ]] && echo "mode: ${mode}"
    [[ -n "$model" ]] && echo "model: ${model}"
    [[ -n "$temperature" ]] && echo "temperature: ${temperature}"
    if [[ -n "$perm" ]]; then
      echo "permission:"
      echo "$perm"
    fi
    echo "---"
    extract_body "$src"
  } > "$dst"

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

  if [[ "$TARGET" == "copilot" || "$TARGET" == "all" ]]; then
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
      # Copilot: nao tem conceito nativo de skill - skip
    done
  fi

  echo
  echo "Build completo. Veja runtimes/$TARGET/"
}

main
