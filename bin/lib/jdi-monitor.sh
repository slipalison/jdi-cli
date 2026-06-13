#!/usr/bin/env bash
# jdi-monitor.sh — context budget monitor (heuristica)
#
# Uso:
#   jdi-monitor.sh [path1 path2 ...]
#
# Estima tokens consumidos por leitura inline dos paths informados
# (heuristica chars/4 = tokens). Le .jdi/config.json pra resolver
# context_window + thresholds. Imprime status pra stderr e sai 0.
#
# Status:
#   PEAK     0-30%   ok, full operations
#   GOOD     30-60%  ok, prefere frontmatter
#   WARN     60-70%  context aquecendo, considere checkpoint
#   CRITICAL 70%+    fracture zone — sugere /jdi-thread
#
# Sai 0 sempre (nao bloqueia). Saida via stderr nao polui pipe.

set -euo pipefail

CONFIG=".jdi/config.json"

# Defaults se config ausente
CONTEXT_WINDOW=200000
WARN_PCT=60
CRITICAL_PCT=70

if [[ -f "$CONFIG" ]]; then
  if command -v jq >/dev/null 2>&1; then
    CONTEXT_WINDOW=$(jq -r '.context_window // 200000' "$CONFIG")
    WARN_PCT=$(jq -r '.thresholds.warn_pct // 60' "$CONFIG")
    CRITICAL_PCT=$(jq -r '.thresholds.critical_pct // 70' "$CONFIG")
  else
    # Fallback grep — funciona pro JSON simples do JDI
    CONTEXT_WINDOW=$(grep -oE '"context_window":[[:space:]]*[0-9]+' "$CONFIG" | head -1 | grep -oE '[0-9]+' || echo 200000)
    WARN_PCT=$(grep -oE '"warn_pct":[[:space:]]*[0-9]+' "$CONFIG" | head -1 | grep -oE '[0-9]+' || echo 60)
    CRITICAL_PCT=$(grep -oE '"critical_pct":[[:space:]]*[0-9]+' "$CONFIG" | head -1 | grep -oE '[0-9]+' || echo 70)
  fi
fi

# Soma chars dos paths informados
TOTAL_CHARS=0
for p in "$@"; do
  if [[ -f "$p" ]]; then
    SZ=$(wc -c < "$p" | tr -d ' ')
    TOTAL_CHARS=$((TOTAL_CHARS + SZ))
  fi
done

# Heuristica: 4 chars ~ 1 token
TOKENS=$((TOTAL_CHARS / 4))
PCT=$((TOKENS * 100 / CONTEXT_WINDOW))

if [[ "$PCT" -ge "$CRITICAL_PCT" ]]; then
  STATE="CRITICAL"
  HINT="fracture zone — considere /jdi-thread (proxima phase em sessao nova)"
elif [[ "$PCT" -ge "$WARN_PCT" ]]; then
  STATE="WARN"
  HINT="context aquecendo — checkpoint recomendado"
elif [[ "$PCT" -ge 30 ]]; then
  STATE="GOOD"
  HINT=""
else
  STATE="PEAK"
  HINT=""
fi

if [[ -n "$HINT" ]]; then
  echo "[jdi-monitor] $STATE ${PCT}% (~${TOKENS} tokens / ${CONTEXT_WINDOW}). $HINT" >&2
else
  echo "[jdi-monitor] $STATE ${PCT}% (~${TOKENS} tokens / ${CONTEXT_WINDOW})" >&2
fi

exit 0
