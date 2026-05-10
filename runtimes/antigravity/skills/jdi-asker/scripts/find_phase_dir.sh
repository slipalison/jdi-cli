#!/usr/bin/env bash
# Resolve o diretorio da phase a partir do numero.
# Uso: ./find_phase_dir.sh <phase_number>
# Saida: caminho relativo do diretorio (.jdi/phases/NN-slug/) ou string vazia.

set -euo pipefail

PHASE="${1:?phase number obrigatorio}"
PADDED=$(printf "%02d" "$PHASE" 2>/dev/null || echo "$PHASE")

# Procura diretorio existente
DIR=$(find .jdi/phases -maxdepth 1 -type d -name "${PADDED}-*" 2>/dev/null | head -1)

if [[ -z "$DIR" ]]; then
  # Procura no ROADMAP.md pra deduzir o slug
  SLUG=$(awk -F'|' -v p="$PADDED" '
    NR > 2 && $2 ~ ("^ *" p " *$") { gsub(/^ +| +$/, "", $3); print $3; exit }
  ' .jdi/ROADMAP.md 2>/dev/null || true)

  if [[ -n "$SLUG" ]]; then
    DIR=".jdi/phases/${PADDED}-${SLUG}"
  fi
fi

echo "$DIR"
