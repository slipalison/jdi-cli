---
name: jdi-plan
description: Gera PLAN.md da phase. Decompoe em tasks com files_modified, acceptance, waves de paralelismo.
argument_hint: "<phase_number> [--review]"
runtime_intent:
  invokes_agent: jdi-planner
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, grep, glob]
  opencode:
    agent: jdi-planner
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-plan"
      - "planejar phase {N}"
---

<objective>
Gera PLAN.md da phase informada. Decompoe em tasks (max 8), agrupa em waves de paralelismo, mapeia files_modified e acceptance.
</objective>

<arguments>
- `phase_number` (obrigatorio): numero da phase, ex `1`, `2`
- `--review` (opcional): mostra preview e pede approve antes de salvar
</arguments>

<process>

### Passo 1: Validacao
```bash
test -d .jdi/ || { echo "Nao eh projeto JDI. Rode /jdi-new."; exit 1; }
test -f .jdi/PROJECT.md || { echo "PROJECT.md ausente."; exit 1; }
```

Verifica CONTEXT.md da phase existe:
```bash
ls .jdi/phases/{NN}*/CONTEXT.md 2>/dev/null || { echo "CONTEXT.md ausente. Rode /jdi-discuss {N}"; exit 1; }
```

### Passo 2: Spawn planner
Invoca `jdi-planner` com phase_number. Aguarda.

### Passo 3: Verifica
```bash
test -f .jdi/phases/{NN}*/PLAN.md || { echo "PLAN.md nao criado"; exit 1; }
```

### Passo 4: Confirma
Mostra resumo do plan + sugere `/jdi-do {N}`.

</process>

<gates>
- pre: `.jdi/PROJECT.md` + `.jdi/phases/{NN-slug}/CONTEXT.md` existem
- post: PLAN.md criado + STATE.md atualizado + commit
</gates>

<errors>
- CONTEXT.md ausente -> sugere `/jdi-discuss {N}`
- Phase nao existe no ROADMAP -> erro
- Planner cancelou -> sai limpo
</errors>
