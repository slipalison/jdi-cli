#!/usr/bin/env bash
# jdi-agent-emit.sh — shared agent emitter: canonical JDI agent frontmatter
# (core/agents/*.md, core/templates/*-specialist.md, .jdi/agents/*.md) ->
# runtime-native agent files.
#
# Sourced by:
#   jdi-build.sh             core/agents/  -> runtimes/<rt>/...
#   jdi-sync-specialists.sh  .jdi/agents/  -> the project's runtime dirs (#33)
#   jdi-install.sh           pt-BR directive injector (shared with sync)
#
# Mirror: jdi-agent-emit.ps1 — every emitter here MUST produce byte-identical
# output to its PowerShell twin (LF, UTF-8 without BOM).
#
# Canonical frontmatter consumed:
#   description:                 -> every runtime
#   triggers: (list)             -> antigravity (skills discover by trigger)
#   runtime_intent.reasoning     -> junie reasoningLevel
#   runtime_overrides.<runtime>: -> claude/copilot {model,tools}
#                                   opencode {mode,model,temperature,permission}
#                                   antigravity {triggers_extra}
#
# Public API (all functions are pure text transforms over one source file):
#   emit_agent_content <runtime> <src.md>        runtime-native file -> stdout
#   emit_agent <runtime> <src.md> <dst.md>       same, written to dst (mkdir -p)
#   agent_dest_path <runtime> <name>             relative path where <runtime>
#                                                discovers agent <name>
#   inject_lang_directive_stream                 stdin -> stdout, idempotent
#   inject_lang_directive_file <file>            in-place variant
#
# Parsing helpers are frontmatter-bounded: every awk program hard-stops at the
# closing `---`, so `---` horizontal rules inside the body never truncate or
# re-enter the frontmatter (the pre-0.11 builders had exactly that bug).

# --- constants (guarded: the lib may be sourced more than once) -------------
if [[ -z "${JDI_AGENT_EMIT_LOADED:-}" ]]; then
  readonly JDI_AGENT_EMIT_LOADED=1
  readonly ANTIGRAVITY="antigravity"
  readonly RT_CLAUDE="claude"
  readonly RT_OPENCODE="opencode"
  readonly RT_JUNIE="junie"
  readonly RT_COPILOT="copilot"
  readonly K_DESC="description"
  readonly K_MODEL="model"
  readonly K_TOOLS="tools"
  readonly FM_DELIM="---"
  readonly LANG_PT_BR="pt-BR"
  readonly LANG_DIRECTIVE_MARKER='<!-- jdi:lang-directive -->'
  JDI_AGENT_EMIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  readonly JDI_AGENT_EMIT_DIR
  readonly LANG_DIRECTIVE_FILE="$JDI_AGENT_EMIT_DIR/../../core/templates/lang-directive.pt-BR.md"
fi

# --- frontmatter parsing ------------------------------------------------------

# Everything after the closing `---` of the frontmatter (body verbatim,
# including any `---` horizontal rules inside it).
extract_body() {
  local file="$1"
  awk '
    fm >= 2 { print; next }
    /^---$/ { fm++ }
  ' "$file"
  return $?
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
  return $?
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
  return $?
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
  return $?
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
  return $?
}

# runtime_intent.reasoning (deep|medium|low) of the canonical frontmatter.
intent_reasoning() {
  local file="$1"
  awk '
    /^---$/ { fm++; if (fm == 2) exit; next }
    fm == 1 && /^runtime_intent:$/ { r = 1; next }
    fm == 1 && r && /^[a-z_-]+:/ { r = 0 }
    fm == 1 && r && /^  reasoning:/ { sub(/^  reasoning:[[:space:]]*/, ""); print; exit }
  ' "$file"
  return $?
}

# --- per-runtime emitters (stdout) -------------------------------------------

# Claude Code and GitHub Copilot: name + description + model + tools taken
# from runtime_overrides.<runtime>. Only the runtime key differs.
emit_scalar_content() {
  local rt="$1" src="$2"
  local name desc model tools
  name="$(basename "$src" .md)"
  desc="$(base_fm_value "$src" "$K_DESC")"
  model="$(override_scalar "$src" "$rt" "$K_MODEL")"
  tools="$(override_scalar "$src" "$rt" "$K_TOOLS")"

  echo "$FM_DELIM"
  echo "name: ${name}"
  [[ -n "$desc" ]] && echo "description: ${desc}"
  [[ -n "$model" ]] && echo "model: ${model}"
  [[ -n "$tools" ]] && echo "tools: ${tools}"
  echo "$FM_DELIM"
  extract_body "$src"
  return $?
}

# Antigravity: agents are skills discovered by description + triggers.
emit_antigravity_content() {
  local src="$1"
  local name desc triggers_block extras
  name="$(basename "$src" .md)"
  desc="$(base_fm_value "$src" "$K_DESC")"
  triggers_block="$(base_fm_block "$src" "triggers")"
  extras="$(override_block "$src" "$ANTIGRAVITY" "triggers_extra")"

  echo "$FM_DELIM"
  echo "name: ${name}"
  [[ -n "$desc" ]] && echo "description: ${desc}"
  if [[ -n "$triggers_block" ]]; then
    echo "$triggers_block"
    [[ -n "$extras" ]] && echo "$extras"
  fi
  echo "$FM_DELIM"
  extract_body "$src"
  return $?
}

# OpenCode: description + mode/model/temperature + permission block. The
# agent name is the filename — OpenCode derives it, so none is emitted.
emit_opencode_content() {
  local src="$1"
  local desc mode model temperature perm
  desc="$(base_fm_value "$src" "$K_DESC")"
  mode="$(override_scalar "$src" "$RT_OPENCODE" "mode")"
  model="$(override_scalar "$src" "$RT_OPENCODE" "$K_MODEL")"
  temperature="$(override_scalar "$src" "$RT_OPENCODE" "temperature")"
  perm="$(override_block "$src" "$RT_OPENCODE" "permission")"

  echo "$FM_DELIM"
  [[ -n "$desc" ]] && echo "description: ${desc}"
  [[ -n "$mode" ]] && echo "mode: ${mode}"
  [[ -n "$model" ]] && echo "model: ${model}"
  [[ -n "$temperature" ]] && echo "temperature: ${temperature}"
  if [[ -n "$perm" ]]; then
    echo "permission:"
    echo "$perm"
  fi
  echo "$FM_DELIM"
  extract_body "$src"
  return $?
}

# Junie subagent (.junie/agents/<n>.md): name + description + tools
# allowlist (enforced by Junie) + reasoningLevel. Tools derive from the
# claude override filtered to Junie's supported set; Agent/WebFetch/Skill
# drop out (Junie delegates natively and has WebSearch only). Model is
# never emitted — Junie is LLM-agnostic and the user picks the model.
emit_junie_content() {
  local src="$1"
  local name desc tools reasoning tools_filtered level
  name="$(basename "$src" .md)"
  desc="$(base_fm_value "$src" "$K_DESC")"
  tools="$(override_scalar "$src" "$RT_CLAUDE" "$K_TOOLS")"
  reasoning="$(intent_reasoning "$src")"

  tools_filtered=""
  if [[ -n "$tools" ]]; then
    tools_filtered=$(echo "$tools" | tr -d '[]' | tr ',' '\n' \
      | sed 's/^ *//; s/ *$//' \
      | grep -E '^(Read|Bash|Glob|Grep|Write|Edit|WebSearch|AskUserQuestion)$' \
      | tr '\n' ',' | sed 's/,$//; s/,/, /g')
  fi

  case "$reasoning" in
    deep) level="high" ;;
    medium) level="medium" ;;
    low) level="low" ;;
    *) level="" ;;
  esac

  echo "$FM_DELIM"
  echo "name: ${name}"
  [[ -n "$desc" ]] && echo "description: ${desc}"
  [[ -n "$tools_filtered" ]] && echo "tools: [${tools_filtered}]"
  [[ -n "$level" ]] && echo "reasoningLevel: ${level}"
  echo "$FM_DELIM"
  extract_body "$src"
  return $?
}

# --- public API ---------------------------------------------------------------

# Runtime-native agent file for <src> -> stdout.
emit_agent_content() {
  local rt="$1" src="$2"
  case "$rt" in
    "$RT_CLAUDE"|"$RT_COPILOT") emit_scalar_content "$rt" "$src" ;;
    "$ANTIGRAVITY")             emit_antigravity_content "$src" ;;
    "$RT_OPENCODE")             emit_opencode_content "$src" ;;
    "$RT_JUNIE")                emit_junie_content "$src" ;;
    *) echo "ERROR: unknown runtime '$rt' (claude|copilot|antigravity|opencode|junie)" >&2; return 2 ;;
  esac
  return $?
}

# Same, written to <dst> (parent dir created).
emit_agent() {
  local rt="$1" src="$2" dst="$3"
  mkdir -p "$(dirname "$dst")"
  emit_agent_content "$rt" "$src" > "$dst"
  return $?
}

# Relative path (from a project root) where <runtime> discovers agent <name>.
# Matches the install layout in PORTABILITY.md.
agent_dest_path() {
  local rt="$1" name="$2"
  case "$rt" in
    "$RT_CLAUDE")   echo ".claude/agents/${name}.md" ;;
    "$RT_COPILOT")  echo ".github/agents/${name}.agent.md" ;;
    "$RT_OPENCODE") echo ".opencode/agents/${name}.md" ;;
    "$ANTIGRAVITY") echo ".agents/skills/${name}/SKILL.md" ;;
    "$RT_JUNIE")    echo ".junie/agents/${name}.md" ;;
    *) echo "ERROR: unknown runtime '$rt'" >&2; return 2 ;;
  esac
  return $?
}

# --- pt-BR language directive ----------------------------------------------
# Inserts core/templates/lang-directive.pt-BR.md right after the closing
# `---` of the frontmatter. Idempotent: a stream already carrying the marker
# passes through unchanged. Used by jdi-install.sh (every installed
# command/agent/skill) and by jdi-sync-specialists.sh (specialist copies).

inject_lang_directive_stream() {
  awk -v directive_file="$LANG_DIRECTIVE_FILE" -v marker="$LANG_DIRECTIVE_MARKER" '
    { lines[++n] = $0; if (index($0, marker) > 0) has_marker = 1 }
    END {
      for (i = 1; i <= n; i++) {
        print lines[i]
        if (!has_marker && lines[i] == "---" && fm < 2) {
          fm++
          if (fm == 2) {
            while ((getline line < directive_file) > 0) print line
            close(directive_file)
          }
        }
      }
    }
  '
  return $?
}

inject_lang_directive_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  grep -qF "$LANG_DIRECTIVE_MARKER" "$file" && return 0

  local tmp
  tmp="$(mktemp)"
  inject_lang_directive_stream < "$file" > "$tmp"
  mv "$tmp" "$file"
  return 0
}
