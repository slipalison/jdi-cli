# Specialists

Per-project doer specialists. Cada projeto tem 1 doer (ou mais, se multi-stack).

`/jdi-do <N>` le esse arquivo. Match -> spawn specialist registrado.

## Format

```markdown
| Stack | Agent | Trigger |
|---|---|---|
| {stack} | jdi-doer-{slug} | {quando aplicar} |
```

Specialists ficam em `.jdi/agents/jdi-doer-{slug}.md` (per-project, NAO no `core/`).

## Como sao criados

`/jdi-bootstrap` invoca o `jdi-architect` em modo specialist:

1. Le `.jdi/PROJECT.md`
2. 6 perguntas focadas (test framework, build/test commands, coverage min, lint, conventions)
3. Substitui placeholders em `core/templates/doer-specialist.md`
4. Write em `.jdi/agents/jdi-doer-{slug}.md`
5. Append linha aqui

## Multi-stack (futuro)

Projeto com backend + frontend pode ter 2 doers:
- `jdi-doer-{slug}-backend` (ex: .NET)
- `jdi-doer-{slug}-frontend` (ex: React)

`/jdi-do <N>` decide qual chamar baseado em `files_modified` do PLAN.md. Hoje `/jdi-bootstrap` cria 1 doer agregado — multi-doer eh feature pendente.

## Entries

| Stack | Agent | Trigger |
|---|---|---|
<!-- Append abaixo via /jdi-bootstrap -->
