---
name: jdi-verify
description: Roda gates de qualidade da phase via reviewer specialist. Build, tests, coverage, lint, security checks. Veredicto APPROVED / APPROVED_WITH_WARNINGS / BLOCKED.
argument_hint: "<phase_number>"
runtime_intent:
  invokes_agent: dynamic
runtime_overrides:
  claude:
    allowed-tools: [Read, Bash, Grep, Glob, Agent]
  copilot:
    tools: [read, grep, glob, terminal]
  opencode:
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-verify"
      - "verificar phase {N}"
---

<objective>
Verifica que a phase foi entregue corretamente. Roda gates definidos no reviewer specialist do projeto. Veredicto bloqueia ou libera o ship.
</objective>

<arguments>
- `phase_number` (obrigatorio)
</arguments>

<process>

### Passo 1: Validacao
```bash
test -d .jdi/ || { echo "Nao eh projeto JDI."; exit 1; }

# Verifica reviewer existe
ls .jdi/agents/jdi-reviewer-*.md 2>/dev/null | head -1 || {
  echo "Reviewer ausente. /jdi-bootstrap."
  exit 1
}

# Verifica phase foi executada
ls .jdi/phases/{NN}*/SUMMARY.md 2>/dev/null || {
  echo "Phase {N} nao executada. /jdi-do {N}."
  exit 1
}

# Context budget warm-up (nao bloqueia)
JDI_LIB="$(dirname "$(command -v jdi 2>/dev/null || echo /usr/local/bin/jdi)")/../lib"
if [ -f "$JDI_LIB/jdi-monitor.sh" ]; then
  bash "$JDI_LIB/jdi-monitor.sh" .jdi/PROJECT.md .jdi/DECISIONS.md .jdi/phases/{NN}*/PLAN.md .jdi/phases/{NN}*/SUMMARY.md || true
fi
# Windows: pwsh -File "$JDI_LIB/jdi-monitor.ps1" -Paths @(...)
```

### Passo 2: Resolve reviewer specialist

```bash
REVIEWER=$(grep -oE 'jdi-reviewer-[a-z0-9-]+' .jdi/reviewers.md | head -1)
```

### Passo 3: Spawn reviewer

```
Agent(
  subagent_type="{REVIEWER}",
  description="Verify phase {N}",
  prompt="phase={N}, mode=verify"
)
```

Reviewer roda gates 1-7 sozinho (definidos no specialist). Read-only. Aguarda.

### Passo 4: Le veredicto

```bash
test -f .jdi/phases/{NN}*/REVIEW.md || { echo "REVIEW.md nao criado"; exit 1; }

VERDICT=$(grep -oE 'Veredicto:\*\* (APPROVED|APPROVED_WITH_WARNINGS|BLOCKED)' .jdi/phases/{NN}*/REVIEW.md | awk '{print $2}')
```

### Passo 5: Atualiza STATE

```markdown
current_phase: {N}
phase_status: {verified|blocked}
phase_verdict: {APPROVED|APPROVED_WITH_WARNINGS|BLOCKED}
next_step: {se APPROVED ou WITH_WARNINGS: /jdi-ship {N}; se BLOCKED: corrige e /jdi-do {N} de novo}
```

```bash
git add .jdi/phases/{NN-slug}/REVIEW.md .jdi/STATE.md
git commit -m "docs({NN-slug}): verify phase ({VERDICT})"
```

### Passo 6: Confirma

**APPROVED:**
```
Phase {N}: APPROVED. Proximo: /jdi-ship {N}
```

**APPROVED_WITH_WARNINGS:**
```
Phase {N}: APPROVED_WITH_WARNINGS ({count} warnings).
REVIEW.md: .jdi/phases/{NN-slug}/REVIEW.md
Proximo: /jdi-ship {N} (ou corrige antes)
```

**BLOCKED:**
```
Phase {N}: BLOCKED ({count} blockers). REVIEW.md: .jdi/phases/{NN-slug}/REVIEW.md
Fix → /jdi-do {N} → /jdi-verify {N}
```

</process>

<gates>
- pre: SUMMARY.md existe + reviewer registrado em .jdi/reviewers.md
- post: REVIEW.md criado + STATE atualizado
</gates>

<errors>
- Reviewer ausente -> /jdi-bootstrap
- SUMMARY ausente -> /jdi-do
- Reviewer falha -> mostra erro, mantem state, sugere retry
</errors>
