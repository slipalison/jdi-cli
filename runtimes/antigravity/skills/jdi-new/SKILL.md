---
name: jdi-new
description: Entry point pra novo projeto. Roda research + asker, gera PROJECT.md + ROADMAP.md.
argument_hint: "<descricao curta do projeto>"
runtime_intent:
  invokes_agent: jdi-researcher
runtime_overrides:
  claude:
    allowed-tools: [Read, Write, Bash, Grep, Glob, AskUserQuestion, WebSearch, WebFetch, Agent]
  copilot:
    tools: [read, write, grep, glob, terminal]
  opencode:
    agent: jdi-researcher
    subtask: true
    model: anthropic/claude-sonnet-4-20250514
  antigravity:
    triggers:
      - "/jdi-new"
      - "criar projeto"
      - "novo app"
---

<objective>
Inicializa novo projeto JDI. Faz research + perguntas chave + gera PROJECT.md, ROADMAP.md, STATE.md, DECISIONS.md.
</objective>

<arguments>
- `descricao` (opcional mas recomendado): texto curto do que se quer construir.

Exemplos:
- `/jdi-new "TODO app .NET 10 + React 19"`
- `/jdi-new "API REST de inventario em Python + FastAPI"`
- `/jdi-new "CLI tool em Go pra parse de logs"`
- `/jdi-new` (asker comeca do zero)
</arguments>

<process>

### Passo 1: Validacao
```bash
test -d .jdi/ && {
  echo ".jdi/ ja existe. Use /jdi-new --reset pra recomecar (CUIDADO: apaga state)."
  exit 1
}
```

Se `--reset` passado, AskUserQuestion confirma + apaga `.jdi/`.

### Passo 2: Spawn researcher
Invoca `jdi-researcher` passando descricao. Aguarda.

### Passo 3: Verifica outputs
```bash
test -f .jdi/PROJECT.md || { echo "PROJECT.md nao criado"; exit 1; }
test -f .jdi/ROADMAP.md || { echo "ROADMAP.md nao criado"; exit 1; }
test -f .jdi/STATE.md || { echo "STATE.md nao criado"; exit 1; }
```

### Passo 4: Cria config.json (token/context budget)

Se `.jdi/config.json` ainda nao existe, escreve o default abaixo. Defaults (200k context, 60/70% warn/critical, coverage 80%) cobrem 95% dos casos. User edita se rodar 1M-window model ou quiser thresholds mais apertados.

```json
{
  "$schema_version": "1.1",
  "context_window": 200000,
  "thresholds": {
    "warn_pct": 60,
    "critical_pct": 70
  },
  "budgets": {
    "max_context_chars": 6000,
    "max_plan_chars": 12000,
    "max_summary_chars": 8192
  },
  "compaction": {
    "keep_phases": 2,
    "archive_after": 5
  },
  "coverage_min": 80
}
```

Referencia canonica do default tambem fica em `templates-jdi-folder/config.json` (shipped pelo pacote npm) — pra users que queiram regenerar manual.

### Passo 5: Confirma

```
{project_name} iniciado. {N} phases planejadas em .jdi/.
Proximo: /jdi-bootstrap
```

</process>

<gates>
- pre: diretorio sem `.jdi/` existente (ou `--reset`)
- post: PROJECT.md + ROADMAP.md + STATE.md + DECISIONS.md + config.json criados, commit inicial feito
</gates>

<errors>
- `.jdi/` ja existe -> sugere `--reset` ou usar projeto atual
- Researcher cancelou -> sai limpo
- Researcher failed -> mostra erro, sem commit
</errors>
