# AGENTS.md — JDI workflow (OpenCode)

Este projeto usa **JDI (Just Do It)** como workflow de desenvolvimento. JDI eh um workflow enxuto: 6 comandos + 5 agents core + 2 specialists per-project.

## Loop canonico

```
/jdi-new "<descricao>"   -> research + PROJECT.md + ROADMAP.md
/jdi-bootstrap           -> cria specialists per-project
/jdi-discuss <N>         -> captura decisoes locked
/jdi-plan <N>            -> decompoe em tasks com waves
/jdi-do <N>              -> executa via doer specialist
/jdi-verify <N>          -> gates via reviewer specialist
/jdi-ship <N>            -> finaliza phase

# Roadmap mutation (qualquer hora)
/jdi-add-phase "<name>" [--goal "<t>"] [--at <pos>]   -> adiciona phase
/jdi-remove-phase <N> [--force]                        -> remove future/pending phase
```

`/jdi-create [desc]` cria agents/skills genericos no `core/` (so dentro do repo JDI).

## Comandos disponiveis

Em `.opencode/commands/`. Invoque via `/` no TUI.

## Subagents (em `.opencode/agents/`)

Invoque via `@` no chat ou via comandos:

| Agent | Modelo | Funcao |
|---|---|---|
| `@jdi-researcher` | sonnet | Research pre-roadmap |
| `@jdi-bootstrap` | sonnet | Cria per-project specialists via architect |
| `@jdi-asker` | sonnet | Loop de perguntas pra CONTEXT.md |
| `@jdi-planner` | sonnet | Gera PLAN.md com waves |
| `@jdi-architect` | sonnet | Meta-agent: cria agents/skills/specialists |

## Specialists per-project (em `.opencode/agents/` apos bootstrap)

`/jdi-bootstrap` gera `.jdi/agents/jdi-doer-{slug}.md` + `.jdi/agents/jdi-reviewer-{slug}.md` baseado no PROJECT.md.

Pra OpenCode reconhecer, copie ou symlink `.jdi/agents/*.md` pra `.opencode/agents/` (ou rode `jdi-install.sh opencode` apos bootstrap).

## Permissions

Frontmatter `permission:` por agent:

| Agent | edit | bash | write |
|---|---|---|---|
| jdi-researcher | deny | deny | allow |
| jdi-bootstrap | allow | allow | allow |
| jdi-asker | deny | deny | allow |
| jdi-planner | deny | deny | allow |
| jdi-architect | allow | allow | allow |
| jdi-doer-{slug} | allow | allow | allow |
| jdi-reviewer-{slug} | deny | allow | deny |

Reviewer eh read-only por design (so roda gates).

## Memoria — files em `.jdi/`

```
.jdi/
  PROJECT.md, ROADMAP.md, DECISIONS.md, STATE.md
  specialists.md, reviewers.md, registry.md
  agents/         <- per-project specialists
  phases/{NN-slug}/{CONTEXT,PLAN,SUMMARY,REVIEW}.md
```

## Skills

OpenCode tambem le `.claude/skills/`. Skills do Claude reutilizadas automaticamente em mesmo projeto.

## Convencoes

- Conventional Commits — scope = phase slug
- Atomic commits — 1 task = 1 commit
- 80% cobertura minima
- Code design locked no `/jdi-new`

## Idioma

- Codigo/commits/PRs: ingles
- Discussao/docs em `.jdi/`: pt-BR

## Prioridade quando conflita

1. Seguranca
2. Performance
3. Boas praticas
