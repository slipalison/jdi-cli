---
name: jdi-discuss
description: Loop adaptativo de perguntas para capturar decisoes locked antes de planejar a phase.
argument_hint: "<phase_number> [--auto]"
runtime_intent:
  invokes_agent: jdi-asker
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, grep, glob]
  opencode:
    agent: jdi-asker
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-discuss"
      - "discutir phase {N}"
      - "iniciar discussao da phase"
---

<objective>
Capturar decisoes locked para a phase informada. Saida: CONTEXT.md que o planner consome.
</objective>

<arguments>
- `phase_number` (obrigatorio): numero da phase, ex `1`, `2`, `3.1`
- `--auto` (opcional): asker decide tudo, sem pergunta. Use quando phase eh trivial.
</arguments>

<process>

### Passo 1: Validacao
1. Confirma `.jdi/` existe. Se nao: "Rode /jdi-new primeiro."
2. Confirma phase existe em ROADMAP.md. Se nao: "Phase {N} nao encontrada."
3. Confirma CONTEXT.md ainda nao existe pra phase. Se sim: pergunta "overwrite ou skip?"

### Passo 2: Spawn asker
Invoca `jdi-asker` com:
- `phase_number={N}`
- `mode=auto` se `--auto`, senao `mode=interactive`

Agente roda processo dele. Retorna quando CONTEXT.md escrito.

### Passo 3: Commit
Apos asker terminar:
```bash
git add .jdi/phases/{NN-slug}/CONTEXT.md .jdi/DECISIONS.md .jdi/todos.md
git commit -m "docs({NN-slug}): capture phase context"
```

### Passo 4: Atualiza state
Edita `.jdi/STATE.md`:
- `current_phase: {NN-slug}`
- `next_step: /jdi-plan {N}`

```bash
git add .jdi/STATE.md
git commit -m "chore(state): phase {NN} discussed"
```

### Passo 5: Confirma
```
CONTEXT.md: .jdi/phases/{NN-slug}/CONTEXT.md ({lines} linhas)
Decisoes capturadas: {count}
Scope creep: {count} item em todos.md

Proximo: /jdi-plan {N}
```

</process>

<gates>
- pre: `.jdi/` existe + phase listada em ROADMAP.md
- post: CONTEXT.md escrito + commit feito + STATE.md atualizado
</gates>

<errors>
- ROADMAP.md nao encontrado -> sai, sugere /jdi-new
- CONTEXT.md ja existe -> pergunta: overwrite | skip | view
- jdi-asker falha -> nao commita, nao atualiza state, mostra erro
</errors>
