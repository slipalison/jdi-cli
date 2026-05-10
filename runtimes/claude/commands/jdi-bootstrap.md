---
name: jdi-bootstrap
description: Cria doer + reviewer specialists per-project. Roda apos /jdi-new, antes de /jdi-discuss.
argument_hint: ""
runtime_intent:
  invokes_agent: jdi-bootstrap
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, edit, terminal]
  opencode:
    agent: jdi-bootstrap
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-bootstrap"
      - "preparar specialists"
      - "setup do projeto"
---

<objective>
Gera os specialists per-project (doer + reviewer) baseado na stack/code-design definidos em PROJECT.md.
</objective>

<arguments>
Nenhum. Le tudo de `.jdi/PROJECT.md`.
</arguments>

<process>

### Passo 1: Validacao
```bash
test -f .jdi/PROJECT.md || { echo "PROJECT.md ausente. Rode /jdi-new primeiro."; exit 1; }
```

### Passo 2: Spawn jdi-bootstrap
Invoca agent. Aguarda.

### Passo 3: Verifica resultado
- created -> mostra confirmacao, sugere `/jdi-discuss 1`
- already-exists + manter -> mostra "ja pronto", sugere `/jdi-discuss 1`
- cancelled -> sai limpo
- failed -> mostra erro

</process>

<gates>
- pre: `.jdi/PROJECT.md` existe + working tree clean (ou changes apenas em `.jdi/`)
- post: `.jdi/agents/jdi-doer-*.md` e `.jdi/agents/jdi-reviewer-*.md` existem + routing atualizado + commit
</gates>

<errors>
- PROJECT.md ausente -> sugere `/jdi-new`
- Architect cancelou -> sai limpo
- Architect failed -> mantem state, mostra erro, sugere retry manual
</errors>
