#!/usr/bin/env bash
# Orquestra o comando jdi-discuss.
# Uso: ./run_command.sh <phase> [--auto]
# Pre-req: jdi-asker skill executou e produziu CONTEXT.md.

set -euo pipefail

PHASE="${1:?phase number obrigatorio}"
PADDED=$(printf "%02d" "$PHASE" 2>/dev/null || echo "$PHASE")

PHASE_DIR=$(find .jdi/phases -maxdepth 1 -type d -name "${PADDED}-*" | head -1)
if [[ -z "$PHASE_DIR" ]]; then
  echo "Erro: diretorio da phase ${PHASE} nao encontrado."
  exit 1
fi

CONTEXT_FILE="${PHASE_DIR}/CONTEXT.md"
if [[ ! -f "$CONTEXT_FILE" ]]; then
  echo "Erro: ${CONTEXT_FILE} nao foi escrito pelo asker."
  exit 1
fi

# Commit do contexto
git add "${CONTEXT_FILE}" .jdi/DECISIONS.md .jdi/todos.md 2>/dev/null || true
git commit -m "docs(${PADDED}): capture phase context" || true

# Atualiza STATE.md
SLUG=$(basename "$PHASE_DIR")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > .jdi/STATE.md <<EOF
---
updated: ${NOW}
last_commit: $(git rev-parse --short HEAD)
current_phase: ${SLUG}
next_step: /jdi-plan ${PHASE}
blockers: []
---

# State

## Where I am
Phase ${PHASE} discutida. Decisoes em DECISIONS.md.

## Last activity
- $(git log -1 --format="%h %s")
EOF

git add .jdi/STATE.md
git commit -m "chore(state): phase ${PADDED} discussed"

DECISIONS_COUNT=$(grep -c "^## D-" .jdi/DECISIONS.md 2>/dev/null || echo 0)
TODOS_COUNT=$(grep -c "^- \[ \]" .jdi/todos.md 2>/dev/null || echo 0)

cat <<EOF

CONTEXT.md: ${CONTEXT_FILE}
Decisoes totais no projeto: ${DECISIONS_COUNT}
Todos pendentes: ${TODOS_COUNT}

Proximo: /jdi-plan ${PHASE}
EOF
