# JDI — Instrucoes GitHub Copilot

Este projeto usa **JDI (Just Do It)** como workflow de desenvolvimento. JDI eh um workflow enxuto: 6 comandos no loop + 5 agents core + 2 per-project specialists.

## Loop canonico

```
/jdi-new "<descricao>"   -> research + PROJECT.md + ROADMAP.md
/jdi-bootstrap           -> cria specialists per-project
/jdi-discuss <N>         -> captura decisoes locked
/jdi-plan <N>            -> decompoe em tasks com waves
/jdi-do <N>              -> executa via doer specialist
/jdi-verify <N>          -> gates via reviewer specialist
/jdi-ship <N>            -> finaliza phase
```

`/jdi-create [desc]` cria agents/skills genericos no `core/` (so dentro do repo JDI).

## Comandos (prompts)

Em `.github/prompts/`. Invoque via `/` no chat.

## Agentes (referencie via `@`)

Em `.github/agents/`:

| Agent | Modelo | Funcao |
|---|---|---|
| `@jdi-researcher` | gpt-5 | Research pre-roadmap |
| `@jdi-bootstrap` | gpt-5 | Cria per-project specialists |
| `@jdi-asker` | gpt-5 | Loop de perguntas |
| `@jdi-planner` | gpt-5 | Gera PLAN.md com waves |
| `@jdi-architect` | gpt-5 | Meta-agent |

## Specialists per-project

Apos `/jdi-bootstrap`, gerados em `.jdi/agents/jdi-doer-{slug}.md` e `.jdi/agents/jdi-reviewer-{slug}.md`.

Pra Copilot reconhecer, copie pra `.github/agents/` (ou rode `jdi-install.sh copilot` apos bootstrap).

## Memoria — files em `.jdi/`

```
.jdi/
  PROJECT.md, ROADMAP.md, DECISIONS.md, STATE.md
  specialists.md, reviewers.md, registry.md
  agents/         <- per-project specialists
  phases/{NN-slug}/{CONTEXT,PLAN,SUMMARY,REVIEW}.md
```

Trate como source of truth.

## Limitacoes Copilot vs Claude

- **Sem hooks runtime**: pre/post-commit em `.githooks/`. Ativar:
  ```bash
  git config core.hooksPath .githooks
  ```
- **Spawn de subagentes via `@`**: usuario invoca explicitamente. Sem auto-spawn transparente.
- **AskUserQuestion**: substituido pela interacao normal de chat.
- **Subagent paralelismo**: nao retorna sinal confiavel. `/jdi-do` defaulta sequencial em Copilot.

## Convencoes

- Conventional Commits — scope = phase slug
- Atomic commits — 1 task = 1 commit
- 80% cobertura minima
- Code design locked no `/jdi-new`
- D-XX referenciado em commit message quando aplicavel

## Idioma

- Codigo/commits/PRs: ingles
- Discussao/docs em `.jdi/`: pt-BR

## Prioridade quando conflita

1. Seguranca
2. Performance
3. Boas praticas
