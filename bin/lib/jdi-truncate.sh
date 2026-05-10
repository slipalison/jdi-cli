#!/usr/bin/env bash
# jdi-truncate.sh — markdown-aware truncation pra context budget
#
# Uso:
#   jdi-truncate.sh <path> [char_budget]
#
# Estrategia:
#   - Preserva YAML frontmatter inteiro
#   - Preserva TODAS as linhas de heading (#, ##, ...)
#   - Preserva 1a linha nao-vazia de cada secao
#   - Resto vira "[... N lines omitted]"
#   - Footer aponta pro arquivo original
#
# Se file <= budget, ecoa inteiro. Output sempre pra stdout.

set -euo pipefail

PATH_IN="${1:-}"
BUDGET="${2:-8192}"

if [ -z "$PATH_IN" ]; then
  echo "uso: jdi-truncate.sh <path> [char_budget]" >&2
  exit 1
fi

if [ ! -f "$PATH_IN" ]; then
  echo "arquivo nao encontrado: $PATH_IN" >&2
  exit 1
fi

SIZE=$(wc -c < "$PATH_IN" | tr -d ' ')

if [ "$SIZE" -le "$BUDGET" ]; then
  cat "$PATH_IN"
  exit 0
fi

awk -v file="$PATH_IN" '
BEGIN {
  in_frontmatter = 0
  frontmatter_done = 0
  paragraph_kept = 0
  omitted = 0
}
{
  line = $0

  # Frontmatter (so se comecar na linha 1)
  if (NR == 1 && line == "---") {
    in_frontmatter = 1
    print line
    next
  }
  if (in_frontmatter) {
    print line
    if (line == "---") {
      in_frontmatter = 0
      frontmatter_done = 1
    }
    next
  }

  # Heading — sempre preserva
  if (line ~ /^#{1,6}[[:space:]]/) {
    if (omitted > 0) {
      print "[... " omitted " lines omitted]"
      omitted = 0
    }
    print line
    paragraph_kept = 0
    next
  }

  # Linha vazia
  if (line ~ /^[[:space:]]*$/) {
    if (paragraph_kept == 0) {
      print line
    } else {
      omitted++
    }
    next
  }

  # Linha de conteudo
  if (paragraph_kept == 0) {
    print line
    paragraph_kept = 1
  } else {
    omitted++
  }
}
END {
  if (omitted > 0) {
    print "[... " omitted " lines omitted]"
  }
  print ""
  print "[Truncated by jdi-truncate. Read " file " for full content]"
}
' "$PATH_IN"
