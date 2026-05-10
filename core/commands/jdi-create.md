---
name: jdi-create
description: Cria novo agent ou skill JDI atraves de loop de perguntas validado e integracao automatica.
argument_hint: "[descricao curta opcional]"
runtime_intent:
  invokes_agent: jdi-architect
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Agent]
  copilot:
    tools: [read, write, edit, terminal]
  antigravity:
    triggers:
      - "/jdi-create"
      - "criar novo agent"
      - "criar novo skill"
      - "estender jdi"
---

<objective>
Criar novo agent ou skill pro JDI atraves de fluxo guiado: loop de perguntas -> classificacao automatica -> validacao com user -> geracao + integracao + smoke test.
</objective>

<arguments>
- `descricao` (opcional): texto livre descrevendo o que se quer criar. Acelera Q1.

Exemplos:
- `/jdi-create`
- `/jdi-create "specialist pra Rust com cargo + clippy"`
- `/jdi-create "reviewer focado em a11y pra UI"`
- `/jdi-create "skill com convencoes EF Core 9"`
</arguments>

<process>

### Passo 1: Validacao

```bash
test -d .jdi/ || { echo "Nao eh projeto JDI. Rode /jdi-new."; exit 1; }
test -d core/  || { echo "Source of truth nao encontrado. Esta no repo do JDI?"; exit 1; }
```

### Passo 2: Spawn architect

Invoca `jdi-architect`:
- Se argumento livre fornecido, passa como contexto pra Q1
- Senao, asker comeca do zero

Aguarda. Architect roda 12 passos (ver `core/agents/jdi-architect.md`).

### Passo 3: Verifica resultado

Architect retorna 1 de 3 status:

- **created** — agent/skill criado, integrado, build+install feitos. Comando confirma com user e termina.
- **cancelled** — user cancelou. Comando sai limpo, sem commit.
- **failed** — algo deu errado (template ausente, conflito de nome, build falhou). Mostra erro, sugere retry.

### Passo 4: Confirma

Se **created**:
```
jdi-{nome} ({tipo}) ok. Audit: R-{N}. Commit: {sha}.
Invocar: {instrucoes runtime}
```

</process>

<gates>
- pre: `.jdi/` existe + `core/` existe + clean working tree (sem mudancas nao commitadas em `core/` pra evitar conflitos)
- post: agent/skill criado + integration points atualizados + build+install feitos + commit atomico
</gates>

<errors>
- Nao eh projeto JDI -> sugere `/jdi-new`
- Source `core/` ausente -> nao eh repo do JDI, redireciona
- Working tree dirty em `core/` -> pede commit ou stash antes
- User cancelou -> sai sem efeito colateral
- Build falhou -> nao instala, mostra erro do build, mantem core/ atualizado pra retry manual
</errors>
